using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RboxAgent.Modules.Ping;
using RboxAgent.Modules.Control;
using RboxAgent.Modules.Files;
using RboxAgent.Modules.Port;
using RboxAgent.Modules.Update;
using RboxAgent.Modules.Ybdb;

namespace RboxAgent
{
    /// <summary>
    /// Yalnızca 127.0.0.1'i dinleyen küçük HTTP sunucusu. Güvenlik katmanları:
    ///  1) Yalnızca loopback adresine bağlanır.
    ///  2) Host başlığı doğrulanır (DNS rebinding).
    ///  3) Origin izin listesinde değilse tarayıcı isteği reddedilir (CORS).
    ///  4) /api/hello dışındaki her uç nokta, konsolda gösterilen açılışa özel kodu (X-Rbox-Token) ister.
    ///  5) Yanlış kod denemeleri sınırlanır.
    /// </summary>
    internal sealed class AgentServer
    {
        // Enum'lar metin olarak ("Enable", "None"...) gider / gelir
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        {
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
        };

        private readonly AgentOptions _o;
        private HttpListener? _listener;
        private int _failures;
        private DateTime _lockedUntil = DateTime.MinValue;

        public AgentServer(AgentOptions o) => _o = o;

        public int Port { get; private set; }

        public void Start()
        {
            for (int p = _o.Port; p < _o.Port + 10; p++)
            {
                var l = new HttpListener();
                l.Prefixes.Add($"http://127.0.0.1:{p}/");
                l.Prefixes.Add($"http://localhost:{p}/");
                try
                {
                    l.Start();
                    _listener = l;
                    Port = p;
                    return;
                }
                catch (HttpListenerException)
                {
                    l.Close(); // port dolu: sıradakini dene
                }
            }
            throw new InvalidOperationException($"{_o.Port}-{_o.Port + 9} arası portların hepsi dolu.");
        }

        public async Task RunAsync()
        {
            while (_listener is { IsListening: true })
            {
                HttpListenerContext ctx;
                try { ctx = await _listener.GetContextAsync(); }
                catch { break; }
                _ = Task.Run(() => HandleAsync(ctx));
            }
        }

        // ── İstek işleme ─────────────────────────────────────────────────────

        private async Task HandleAsync(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            try
            {
                if (!HostOk(req)) { await Text(res, 400, "Bad host"); return; }

                string? origin = req.Headers["Origin"];
                if (origin != null)
                {
                    if (!OriginOk(origin)) { await Text(res, 403, "Origin izinli değil"); return; }
                    res.Headers["Access-Control-Allow-Origin"] = origin;
                    res.Headers["Vary"] = "Origin";
                    res.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Rbox-Token, X-File-Name";
                    res.Headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
                    res.Headers["Access-Control-Allow-Private-Network"] = "true";
                    res.Headers["Access-Control-Max-Age"] = "600";
                }
                if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

                string path = req.Url!.AbsolutePath;
                if (!path.StartsWith("/api/", StringComparison.Ordinal))
                {
                    await StaticAsync(res, path);
                    return;
                }

                res.Headers["Cache-Control"] = "no-store";

                if (path == "/api/hello")
                {
                    await Reply(res, new
                    {
                        app = "RboxAgent",
                        version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3),
                        machine = Environment.MachineName,
                        port = Port,
                        dotnet = Environment.Version.ToString(),
                        authorized = TokenOk(req, countFailure: false),
                    });
                    return;
                }

                if (!TokenOk(req, countFailure: true))
                {
                    await Reply(res, new { error = _lockedUntil > DateTime.UtcNow ? "Çok fazla hatalı deneme. Biraz bekleyin." : "Kod hatalı." }, 401);
                    return;
                }

                await RouteAsync(req, res, path);
            }
            catch (Exception ex)
            {
                try { await Reply(res, new { error = ex.Message }, 500); } catch { }
            }
        }

        private async Task RouteAsync(HttpListenerRequest req, HttpListenerResponse res, string path)
        {
            string m = req.HttpMethod;
            var ping = DataStore.Settings.Ping;

            switch (m, path)
            {
                case ("GET", "/api/auth"):
                    await Reply(res, new { ok = true });
                    return;

                // ── Excel ────────────────────────────────────────────────────
                case ("POST", "/api/excel"):
                {
                    string name = Uri.UnescapeDataString(req.Headers["X-File-Name"] ?? "liste.xlsx");
                    string ext = Path.GetExtension(name).ToLowerInvariant();
                    if (ext is not (".xlsx" or ".xls")) ext = ".xlsx";
                    string tmp = Path.Combine(Path.GetTempPath(), $"rboxagent_{Guid.NewGuid():N}{ext}");
                    try
                    {
                        await using (var f = File.Create(tmp)) await req.InputStream.CopyToAsync(f);
                        var rows = ExcelReader.LoadDevices(tmp);
                        await Reply(res, new { fileName = Path.GetFileName(name), rows = rows.Select(PingService.ToRowDto) });
                    }
                    catch (Exception ex)
                    {
                        await Reply(res, new { error = ex.Message }, 422);
                    }
                    finally { try { File.Delete(tmp); } catch { } }
                    return;
                }

                // ── Ping ayarları ────────────────────────────────────────────
                case ("GET", "/api/settings/ping"):
                    OuiLookup.Preload();
                    await Reply(res, new
                    {
                        ping.CheckSsh, ping.CheckMac, ping.CheckVendor, ping.SshMacFallback,
                        ping.Concurrency, ping.PingTimeoutMs, ping.TcpTimeoutMs, ping.SshTimeoutMs, ping.MonitorIntervalMin,
                        oui = OuiLookup.SourceDescription,
                    });
                    return;

                case ("PUT", "/api/settings/ping"):
                {
                    var b = await Body<PingSettingsIn>(req);
                    if (b.CheckSsh is bool a1) ping.CheckSsh = a1;
                    if (b.CheckMac is bool a2) ping.CheckMac = a2;
                    if (b.CheckVendor is bool a3) ping.CheckVendor = a3;
                    if (b.SshMacFallback is bool a4) ping.SshMacFallback = a4;
                    if (b.MonitorIntervalMin is int mi) ping.MonitorIntervalMin = Math.Clamp(mi, 1, 120);
                    DataStore.Save();
                    await Reply(res, new { ok = true });
                    return;
                }

                // ── Ortak SSH kullanıcı / parola (tüm modüller) ───────────────
                case ("GET", "/api/settings/ssh"):
                    await Reply(res, new { user = DataStore.Settings.Ssh.User, hasPass = !string.IsNullOrEmpty(DataStore.Settings.Ssh.PassProtected) });
                    return;

                case ("PUT", "/api/settings/ssh"):
                {
                    var b = await Body<SshSettingsIn>(req);
                    var ssh = DataStore.Settings.Ssh;
                    if (b.User != null) ssh.User = string.IsNullOrWhiteSpace(b.User) ? "pi" : b.User.Trim();
                    if (b.Pass != null) ssh.PassProtected = DataStore.Protect(b.Pass);   // "" → parola silinir
                    DataStore.Save();
                    await Reply(res, new { ok = true });
                    return;
                }

                // ── Port Kontrol (salt okunur) ────────────────────────────────
                case ("POST", "/api/port/inspect"):
                {
                    var b = await Body<PortQueryIn>(req);
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
                    await Reply(res, await PortInspector.InspectAsync(b.Query, b.Host, cts.Token));
                    return;
                }

                // ── YBDB (SQL Server, salt okunur) ────────────────────────────
                case ("GET", "/api/ybdb/settings"):
                {
                    var y = DataStore.Settings.Ybdb;
                    await Reply(res, new
                    {
                        server = y.Server ?? YbdbService.PreferredIPv4() ?? "",
                        user = y.User,
                        remember = y.RememberPassword,
                        hasPass = !string.IsNullOrEmpty(y.PassProtected),
                        connected = YbdbService.Connected,
                        connectedServer = YbdbService.ConnectedServer,
                    });
                    return;
                }

                case ("POST", "/api/ybdb/connect"):
                {
                    var b = await Body<ConnectRequest>(req);
                    var (ok, message) = await YbdbService.ConnectAsync(b);
                    await Reply(res, ok ? new { ok = true, server = message } : new { ok = false, error = message }, ok ? 200 : 422);
                    return;
                }

                case ("GET", "/api/ybdb/data"):
                {
                    if (!YbdbService.Connected) { await Reply(res, new { error = "Bağlı değil." }, 409); return; }
                    try { await Reply(res, await YbdbService.LoadAsync()); }
                    catch (Exception ex) { await Reply(res, new { error = YbdbRepository.FriendlyError(ex) }, 422); }
                    return;
                }

                // ── YBDB Cihaz tablosu (ekle / güncelle / sil) ────────────────
                case ("GET", "/api/ybdb/cihaz"):
                {
                    if (YbdbService.Cihazlar is not { } repo) { await Reply(res, new { error = "Bağlı değil." }, 409); return; }
                    try { await Reply(res, new { cihazlar = await repo.ListAsync(), zaman = DateTime.Now.ToString("dd.MM.yyyy HH:mm:ss") }); }
                    catch (Exception ex) { await Reply(res, new { error = YbdbRepository.FriendlyError(ex) }, 422); }
                    return;
                }

                case ("POST", "/api/ybdb/cihaz"):
                {
                    if (YbdbService.Cihazlar is not { } repo) { await Reply(res, new { error = "Bağlı değil." }, 409); return; }
                    var b = await Body<CihazSaveIn>(req);
                    if (b.Changed == null) { await Reply(res, new { error = "Eksik veri." }, 400); return; }
                    try
                    {
                        // original yoksa yeni kayıt; varsa okunduğu haliyle karşılaştırılarak güncellenir
                        int id = b.Original == null ? await repo.InsertAsync(b.Changed) : b.Original.Id;
                        if (b.Original != null) await repo.UpdateAsync(b.Original, b.Changed);
                        await Reply(res, new { ok = true, id });
                    }
                    catch (Exception ex) { await Reply(res, new { error = CihazRepository.FriendlyWriteError(ex) }, 422); }
                    return;
                }

                case ("POST", "/api/ybdb/cihaz/delete"):
                {
                    if (YbdbService.Cihazlar is not { } repo) { await Reply(res, new { error = "Bağlı değil." }, 409); return; }
                    var b = await Body<CihazSaveIn>(req);
                    if (b.Original == null) { await Reply(res, new { error = "Eksik veri." }, 400); return; }
                    try { await repo.DeleteAsync(b.Original); await Reply(res, new { ok = true }); }
                    catch (Exception ex) { await Reply(res, new { error = CihazRepository.FriendlyWriteError(ex) }, 422); }
                    return;
                }

                case ("POST", "/api/ybdb/cihaz/bulk"):
                {
                    if (YbdbService.Cihazlar is not { } repo) { await Reply(res, new { error = "Bağlı değil." }, 409); return; }
                    var b = await Body<CihazBulkIn>(req);
                    if (b.Rows == null || b.Rows.Count == 0) { await Reply(res, new { error = "Eklenecek kayıt yok." }, 400); return; }
                    try { var ids = await repo.InsertManyAsync(b.Rows); await Reply(res, new { ok = true, ids }); }
                    catch (Exception ex) { await Reply(res, new { error = CihazRepository.FriendlyWriteError(ex) }, 422); }
                    return;
                }

                // ── Cihaz Güncelleme ──────────────────────────────────────────
                case ("GET", "/api/update/info"):
                    await Reply(res, UpdateService.Info());
                    return;

                case ("GET", "/api/update/settings"):
                {
                    var u = DataStore.Settings.Update;
                    await Reply(res, u);
                    return;
                }

                case ("PUT", "/api/update/settings"):
                {
                    var b = await Body<UpdateSettings>(req);
                    var u = DataStore.Settings.Update;
                    u.Parallel = Math.Clamp(b.Parallel, 1, 100);
                    u.TtyText = b.TtyText ?? u.TtyText;
                    u.Wlan0Mask = b.Wlan0Mask ?? u.Wlan0Mask; u.Wlan0Gateway = b.Wlan0Gateway ?? u.Wlan0Gateway;
                    u.Eth0Mask = b.Eth0Mask ?? u.Eth0Mask; u.Eth0Gateway = b.Eth0Gateway ?? u.Eth0Gateway;
                    u.SequentialIpFill = b.SequentialIpFill;
                    u.SingleTargetIp = b.SingleTargetIp ?? u.SingleTargetIp; u.SingleServerIp = b.SingleServerIp ?? u.SingleServerIp;
                    u.SingleEth0Ip = b.SingleEth0Ip ?? u.SingleEth0Ip; u.SingleEth0Mask = b.SingleEth0Mask ?? u.SingleEth0Mask;
                    u.SingleWlan0Ip = b.SingleWlan0Ip ?? u.SingleWlan0Ip; u.SingleWlan0Mask = b.SingleWlan0Mask ?? u.SingleWlan0Mask;
                    DataStore.Save();
                    await Reply(res, new { ok = true });
                    return;
                }

                case ("POST", "/api/update/run"):
                case ("POST", "/api/update/version"):
                {
                    bool isRun = path.EndsWith("/run");
                    if (UpdateService.Credentials() == null) { await Reply(res, new { error = "SSH kullanıcı adı ve şifre girin (üst banttaki SSH düğmesi)." }, 422); return; }
                    if (!UpdateService.TryBegin()) { await Reply(res, new { error = "Başka bir güncelleme / versiyon kontrolü sürüyor." }, 409); return; }

                    UpdateRunRequest? runReq = null; VersionRequest? verReq = null;
                    try
                    {
                        if (isRun) runReq = await Body<UpdateRunRequest>(req); else verReq = await Body<VersionRequest>(req);
                    }
                    catch { UpdateService.End(); await Reply(res, new { error = "Geçersiz istek." }, 400); return; }

                    res.StatusCode = 200;
                    res.ContentType = "application/x-ndjson; charset=utf-8";
                    res.SendChunked = true;
                    var sink = new NdjsonSink(res.OutputStream, Json);
                    string runId = Guid.NewGuid().ToString("N");
                    try
                    {
                        if (isRun) await UpdateService.RunUpdateAsync(runId, runReq!, sink);
                        else await UpdateService.RunVersionAsync(runId, verReq!, sink);
                    }
                    finally
                    {
                        UpdateService.End();
                        await sink.CompleteAsync();
                        try { res.Close(); } catch { }
                    }
                    return;
                }

                case ("POST", "/api/update/cancel"):
                    await Reply(res, new { ok = UpdateService.Cancel(req.QueryString["id"] ?? "") });
                    return;

                case ("POST", "/api/update/tty"):
                {
                    var b = await Body<TtyRequest>(req);
                    if (UpdateService.Credentials() == null) { await Reply(res, new { ok = false, message = "SSH kullanıcı adı ve şifre girin (üst banttaki SSH düğmesi)." }); return; }
                    if (string.IsNullOrWhiteSpace(b.Ip)) { await Reply(res, new { ok = false, message = "Listeden bir cihaz seçin." }); return; }
                    if (string.IsNullOrWhiteSpace(b.Text)) { await Reply(res, new { ok = false, message = "Gönderilecek metin boş." }); return; }
                    var (ok, message) = await UpdateService.SendTtyAsync(b.Ip.Trim(), b.Text);
                    await Reply(res, new { ok, message });
                    return;
                }

                case ("POST", "/api/update/single"):
                {
                    var b = await Body<SingleRequest>(req);
                    string? err = UpdateService.ValidateSingle(b);
                    if (err == null && UpdateService.Credentials() == null) err = "Kullanıcı adı ve şifre girin (üst banttaki SSH düğmesi).";
                    if (err != null) { await Reply(res, new { error = err }, 422); return; }

                    res.StatusCode = 200;
                    res.ContentType = "application/x-ndjson; charset=utf-8";
                    res.SendChunked = true;
                    var sink = new NdjsonSink(res.OutputStream, Json);
                    try { await UpdateService.RunSingleAsync(b, sink); }
                    finally { await sink.CompleteAsync(); try { res.Close(); } catch { } }
                    return;
                }

                case ("POST", "/api/update/open"):
                {
                    var b = await Body<OpenRequest>(req);
                    var (ok, message) = UpdateService.OpenOnServer(b.Kind ?? "", b.Name);
                    // Hata metni "error" anahtarında gider: arayüz bunu kullanıcıya olduğu gibi gösterir
                    await Reply(res, ok ? new { ok = true, error = "" } : new { ok = false, error = message }, ok ? 200 : 422);
                    return;
                }

                case ("PUT", "/api/update/workfolder"):
                {
                    var b = await Body<WorkFolderRequest>(req);
                    var (ok, message) = UpdateService.SetWorkFolder(b.Path);
                    await Reply(res, ok ? new { ok = true, error = "" } : new { ok = false, error = message }, ok ? 200 : 422);
                    return;
                }

                // ── Cihaz Kontrol ─────────────────────────────────────────────
                case ("POST", "/api/control/refresh"):
                case ("POST", "/api/control/exec"):
                {
                    bool isRefresh = path.EndsWith("/refresh");
                    if (UpdateService.Credentials() == null) { await Reply(res, new { error = "SSH kullanıcı adı ve şifre girin (üst banttaki SSH düğmesi)." }, 422); return; }

                    CtlRefreshRequest? rr = null; CtlExecRequest? er = null;
                    try { if (isRefresh) rr = await Body<CtlRefreshRequest>(req); else er = await Body<CtlExecRequest>(req); }
                    catch { await Reply(res, new { error = "Geçersiz istek." }, 400); return; }
                    if (er != null && !ControlService.IsKnownAction(er.Action)) { await Reply(res, new { error = "Bilinmeyen işlem." }, 400); return; }
                    if (!ControlService.TryBegin()) { await Reply(res, new { error = "Başka bir işlem sürüyor." }, 409); return; }

                    res.StatusCode = 200;
                    res.ContentType = "application/x-ndjson; charset=utf-8";
                    res.SendChunked = true;
                    var sink = new NdjsonSink(res.OutputStream, Json);
                    try
                    {
                        if (isRefresh) await ControlService.RefreshAsync(rr!, sink);
                        else await ControlService.ExecAsync(er!, sink);
                    }
                    finally { ControlService.End(); await sink.CompleteAsync(); try { res.Close(); } catch { } }
                    return;
                }

                // ── Dosyalar (updateFiles klasörü) ────────────────────────────
                case ("GET", "/api/files/list"):
                    await Reply(res, FilesService.List());
                    return;

                case ("GET", "/api/files/read"):
                {
                    var (ok, error, data) = FilesService.Read(req.QueryString["path"]);
                    await Reply(res, ok ? data! : new { error }, ok ? 200 : 422);
                    return;
                }

                case ("PUT", "/api/files/write"):
                {
                    var (ok, error) = FilesService.Write(await Body<WriteRequest>(req));
                    await Reply(res, ok ? new { ok = true, error = "" } : new { ok = false, error = error ?? "" }, ok ? 200 : 422);
                    return;
                }

                case ("POST", "/api/files/upload"):
                {
                    var (ok, status, error) = await FilesService.UploadAsync(req.QueryString["path"], req.InputStream, req.QueryString["overwrite"] == "1");
                    await Reply(res, ok ? new { ok = true, error = "" } : new { ok = false, error = error ?? "" }, status);
                    return;
                }

                case ("DELETE", "/api/files"):
                {
                    var (ok, error) = FilesService.Delete(req.QueryString["path"]);
                    await Reply(res, ok ? new { ok = true, error = "" } : new { ok = false, error = error ?? "" }, ok ? 200 : 422);
                    return;
                }

                case ("POST", "/api/files/rename"):
                {
                    var (ok, error) = FilesService.Rename(await Body<RenameRequest>(req));
                    await Reply(res, ok ? new { ok = true, error = "" } : new { ok = false, error = error ?? "" }, ok ? 200 : 422);
                    return;
                }

                case ("GET", "/api/files/download"):
                {
                    string? file = FilesService.ResolveExisting(req.QueryString["path"]);
                    if (file == null) { await Reply(res, new { error = "Dosya bulunamadı." }, 404); return; }
                    await using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    res.StatusCode = 200;
                    res.ContentType = "application/octet-stream";
                    res.ContentLength64 = fs.Length;
                    await fs.CopyToAsync(res.OutputStream);
                    res.Close();
                    return;
                }

                case ("GET", "/api/files/zip"):
                {
                    res.StatusCode = 200;
                    res.ContentType = "application/zip";
                    res.SendChunked = true;
                    await FilesService.WriteZipAsync(res.OutputStream);
                    res.Close();
                    return;
                }

                case ("POST", "/api/files/import"):
                {
                    var (ok, error, count) = await FilesService.ImportZipAsync(req.InputStream);
                    await Reply(res, ok ? new { ok = true, error = "", count } : new { ok = false, error = error ?? "", count }, ok ? 200 : 422);
                    return;
                }

                case ("POST", "/api/files/fetch"):
                {
                    var b = await Body<FetchRequest>(req);
                    var (ok, error, added, skipped) = await FilesService.FetchFromGitHubAsync(b?.Repo, b?.Overwrite == true);
                    await Reply(res, new { ok, error = error ?? "", added, skipped }, ok ? 200 : 422);
                    return;
                }

                // ── Ping çalıştırma (satır satır akan JSON) ──────────────────
                case ("POST", "/api/ping/run"):
                {
                    var body = await Body<RunRequest>(req);
                    string runId = Guid.NewGuid().ToString("N");
                    res.StatusCode = 200;
                    res.ContentType = "application/x-ndjson; charset=utf-8";
                    res.SendChunked = true;
                    var stream = res.OutputStream;

                    async Task Emit(object o)
                    {
                        byte[] line = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(o, Json) + "\n");
                        await stream.WriteAsync(line);
                        await stream.FlushAsync();
                    }

                    try
                    {
                        await Emit(new { type = "start", runId, total = body.Rows.Count });
                        await PingService.RunAsync(runId, body, Emit, CancellationToken.None);
                    }
                    finally { try { res.Close(); } catch { } }
                    return;
                }

                case ("POST", "/api/ping/cancel"):
                    await Reply(res, new { ok = PingService.Cancel(req.QueryString["id"] ?? "") });
                    return;

                case ("POST", "/api/ping/ssh"):
                {
                    var b = await Body<IpIn>(req);
                    bool ok = false;
                    try { ok = PingService.OpenSsh(b.Ip ?? "", DataStore.Settings.Ssh.User.Trim()); } catch { }
                    await Reply(res, new { ok }, ok ? 200 : 400);
                    return;
                }

                // ── Sürekli ping ("ping ip -t" sekmeleri) ─────────────────────
                case ("POST", "/api/ping/live/start"):
                {
                    var b = await Body<IpIn>(req);
                    var (ok, error, id) = LivePingService.Start(b.Ip);
                    await Reply(res, ok ? new { ok, id } : new { ok, error }, ok ? 200 : 422);
                    return;
                }

                case ("POST", "/api/ping/live/stop"):
                case ("POST", "/api/ping/live/resume"):
                case ("POST", "/api/ping/live/remove"):
                {
                    var b = await Body<LiveIdIn>(req);
                    bool ok = path switch
                    {
                        "/api/ping/live/stop" => LivePingService.Stop(b.Id),
                        "/api/ping/live/resume" => LivePingService.Resume(b.Id),
                        _ => LivePingService.Remove(b.Id),
                    };
                    await Reply(res, new { ok });
                    return;
                }

                case ("POST", "/api/ping/live/poll"):
                {
                    var b = await Body<LivePollIn>(req);
                    await Reply(res, LivePingService.Poll(b.Cursors));
                    return;
                }
            }

            await Reply(res, new { error = "Bulunamadı" }, 404);
        }

        private sealed class IpIn { public string? Ip { get; set; } }
        private sealed class PortQueryIn { public string? Query { get; set; } public string? Host { get; set; } }
        private sealed class LiveIdIn { public int Id { get; set; } }
        private sealed class CihazSaveIn { public CihazKaydi? Original { get; set; } public CihazKaydi? Changed { get; set; } }
        private sealed class CihazBulkIn { public List<CihazKaydi>? Rows { get; set; } }
        private sealed class LivePollIn { public Dictionary<string, long>? Cursors { get; set; } }
        private sealed class OpenRequest { public string? Kind { get; set; } public string? Name { get; set; } }
        private sealed class WorkFolderRequest { public string? Path { get; set; } }
        private sealed class SshSettingsIn
        {
            public string? User { get; set; }
            public string? Pass { get; set; }
        }

        private sealed class PingSettingsIn
        {
            public bool? CheckSsh { get; set; }
            public bool? CheckMac { get; set; }
            public bool? CheckVendor { get; set; }
            public bool? SshMacFallback { get; set; }
            public int? MonitorIntervalMin { get; set; }
        }

        // ── Güvenlik ─────────────────────────────────────────────────────────

        private bool HostOk(HttpListenerRequest req)
        {
            string host = req.Headers["Host"] ?? "";
            int i = host.LastIndexOf(':');
            string name = i > 0 ? host[..i] : host;
            return name is "127.0.0.1" or "localhost";
        }

        private bool OriginOk(string origin)
        {
            if (origin.Equals($"http://127.0.0.1:{Port}", StringComparison.OrdinalIgnoreCase)) return true;
            if (origin.Equals($"http://localhost:{Port}", StringComparison.OrdinalIgnoreCase)) return true;
            return _o.AllowedOrigins.Any(o => o.Equals(origin.TrimEnd('/'), StringComparison.OrdinalIgnoreCase));
        }

        private bool TokenOk(HttpListenerRequest req, bool countFailure)
        {
            if (DateTime.UtcNow < _lockedUntil) return false;

            string given = req.Headers["X-Rbox-Token"] ?? "";
            bool ok = given.Length > 0 && CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(Normalize(given)), Encoding.UTF8.GetBytes(Normalize(_o.Token)));

            if (ok) { _failures = 0; return true; }
            if (countFailure && given.Length > 0 && Interlocked.Increment(ref _failures) >= 8)
            {
                _failures = 0;
                _lockedUntil = DateTime.UtcNow.AddMinutes(1);
            }
            return false;
        }

        private static string Normalize(string s) => s.Replace("-", "").Replace(" ", "").ToUpperInvariant();

        // ── Yanıt yardımcıları ───────────────────────────────────────────────

        private static async Task<T> Body<T>(HttpListenerRequest req) where T : new()
        {
            var v = await JsonSerializer.DeserializeAsync<T>(req.InputStream, Json);
            return v ?? new T();
        }

        private static async Task Reply(HttpListenerResponse res, object body, int status = 200)
        {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(body, Json);
            res.StatusCode = status;
            res.ContentType = "application/json; charset=utf-8";
            res.ContentLength64 = bytes.Length;
            await res.OutputStream.WriteAsync(bytes);
            res.Close();
        }

        private static async Task Text(HttpListenerResponse res, int status, string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            res.StatusCode = status;
            res.ContentType = "text/plain; charset=utf-8";
            res.ContentLength64 = bytes.Length;
            await res.OutputStream.WriteAsync(bytes);
            res.Close();
        }

        // ── Statik site (isteğe bağlı: exe'nin yanındaki "site" klasörü) ─────

        private static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8", [".css"] = "text/css; charset=utf-8",
            [".js"] = "text/javascript; charset=utf-8", [".json"] = "application/json",
            [".svg"] = "image/svg+xml", [".png"] = "image/png", [".ico"] = "image/x-icon",
        };

        private async Task StaticAsync(HttpListenerResponse res, string path)
        {
            string? root = _o.SiteFolder;
            if (root == null || !Directory.Exists(root)) { await Text(res, 404, "Site klasörü yok. Arayüz GitHub Pages'ten açılır."); return; }

            string rel = Uri.UnescapeDataString(path.TrimStart('/'));
            if (rel.Length == 0) rel = "index.html";
            string full = Path.GetFullPath(Path.Combine(root, rel));
            if (!full.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            { await Text(res, 404, "Bulunamadı"); return; }

            byte[] data = await File.ReadAllBytesAsync(full);
            res.StatusCode = 200;
            res.ContentType = Mime.GetValueOrDefault(Path.GetExtension(full), "application/octet-stream");
            res.Headers["Cache-Control"] = "no-cache";
            res.ContentLength64 = data.Length;
            await res.OutputStream.WriteAsync(data);
            res.Close();
        }
    }
}
