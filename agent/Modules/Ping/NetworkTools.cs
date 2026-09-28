using Renci.SshNet;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace RboxAgent.Modules.Ping
{
    public static class NetworkTools
    {
        /// <summary>
        /// Ping atar; başarılıysa gidiş-dönüş süresini (ms), değilse null döner.
        /// Sadece kullanıcı iptali OperationCanceledException fırlatır.
        /// </summary>
        public static async Task<long?> PingAsync(IPAddress ip, int timeoutMs, CancellationToken ct)
        {
            using var p = new System.Net.NetworkInformation.Ping();
            try
            {
                var reply = await p.SendPingAsync(ip, TimeSpan.FromMilliseconds(timeoutMs), null, null, ct)
                                   .ConfigureAwait(false);
                return reply.Status == IPStatus.Success ? reply.RoundtripTime : null;
            }
            catch (PingException)
            {
                return null;
            }
        }

        /// <summary>
        /// TCP portu açık mı? Zaman aşımı/red "false"; kullanıcı iptali OperationCanceledException.
        /// </summary>
        public static async Task<bool> CheckTcpPortOpenAsync(IPAddress ip, int port, int timeoutMs, CancellationToken ct)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(timeoutMs);
            using var client = new TcpClient(ip.AddressFamily);
            try
            {
                await client.ConnectAsync(ip, port, timeoutCts.Token).ConfigureAwait(false);
                return client.Connected;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return false; // zaman aşımı
            }
            catch (SocketException)
            {
                return false;
            }
        }

        // Windows-only SendARP for MAC address
        [DllImport("iphlpapi.dll", ExactSpelling = true)]
        private static extern int SendARP(int DestIP, int SrcIP, byte[] pMacAddr, ref int PhyAddrLen);

        /// <summary>
        /// ARP ile MAC okur. SendARP bloklayan bir çağrı olduğu için thread pool'da çalışır,
        /// böylece arayüz donmaz. SendARP kendisi iptal edilemez; iptalde sadece beklemeyi bırakırız.
        /// </summary>
        public static Task<string?> GetMacFromArpAsync(IPAddress ip, CancellationToken ct)
        {
            if (ip.AddressFamily != AddressFamily.InterNetwork)
                return Task.FromResult<string?>(null); // IPv4 only

            return Task.Run(() =>
            {
                try
                {
                    byte[] macAddr = new byte[6];
                    int len = macAddr.Length;
                    int dest = BitConverter.ToInt32(ip.GetAddressBytes(), 0);
                    int res = SendARP(dest, 0, macAddr, ref len);
                    if (res != 0 || len <= 0) return null;
                    return BitConverter.ToString(macAddr, 0, len).Replace('-', ':');
                }
                catch
                {
                    return null;
                }
            }, ct).WaitAsync(ct);
        }

        /// <summary>
        /// SSH ile bağlanıp cihazın MAC adresini okur.
        /// Öncelik: UP olan arabirim → değilse ilk non-lo arabirim.
        /// </summary>
        public static async Task<string?> GetMacViaSshAsync(
            IPAddress ip, string user, string pass, int timeoutMs, CancellationToken ct)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(timeoutMs);
            try
            {
                var ci = new ConnectionInfo(ip.ToString(), user, new PasswordAuthenticationMethod(user, pass))
                {
                    Timeout = TimeSpan.FromMilliseconds(timeoutMs)
                };

                using var cli = new SshClient(ci);
                // İç ağdaki cihazlar için bilinçli tercih: host key doğrulanmıyor, tüm anahtarlar kabul ediliyor.
                cli.HostKeyReceived += (_, e) => e.CanTrust = true;

                await cli.ConnectAsync(timeoutCts.Token).ConfigureAwait(false);
                if (!cli.IsConnected) return null;

                // POSIX sh (BusyBox/OpenWrt'de de var), lo hariç arabirimleri listeler: "<ifname> <mac> <state>"
                using var cmd = cli.CreateCommand(
                    "sh -c 'for i in /sys/class/net/*; do n=${i##*/}; " +
                    " [ \"$n\" = lo ] && continue; " +
                    " addr=$(cat $i/address 2>/dev/null); " +
                    " st=$(cat $i/operstate 2>/dev/null); " +
                    " if [ -n \"$addr\" ]; then echo \"$n $addr $st\"; fi; " +
                    "done'");
                cmd.CommandTimeout = TimeSpan.FromMilliseconds(timeoutMs);

                await cmd.ExecuteAsync(timeoutCts.Token).ConfigureAwait(false);
                string output = cmd.Result;
                cli.Disconnect();

                return ParseMacFromInterfaceList(output);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw; // kullanıcı iptali yukarı gitsin
            }
            catch
            {
                return null; // zaman aşımı, kimlik doğrulama hatası vb.
            }
        }

        private static string? ParseMacFromInterfaceList(string? output)
        {
            if (string.IsNullOrWhiteSpace(output)) return null;

            var lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            string? chosen = lines.FirstOrDefault(l => l.TrimEnd().EndsWith(" up", StringComparison.OrdinalIgnoreCase))
                             ?? lines.FirstOrDefault();
            if (chosen == null) return null;

            var parts = chosen.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) return null;

            string mac = MacAddress.ToDisplay(parts[1]);
            return MacAddress.IsValid(mac) ? mac : null;
        }
    }
}
