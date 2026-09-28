namespace RboxAgent.Modules.Update.Core
{
    public enum StatusKind { Info, Warn, Error, Success }

    public interface IStatusReporter
    {
        void Set(string ip, string message, StatusKind kind = StatusKind.Info, string? timestamp = null);
    }
}
