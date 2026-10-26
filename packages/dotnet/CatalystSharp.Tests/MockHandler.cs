using System.Net;
using System.Text;

namespace CatalystSharp.Tests;

/// <summary>A request as seen by the handler, copied before the message is disposed.</summary>
public sealed record RecordedRequest(HttpMethod Method, Uri Url, IReadOnlyDictionary<string, string> Headers, string? Body)
{
    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;

    public bool IsToken => Url.AbsolutePath == "/token";
}

/// <summary>An <see cref="HttpMessageHandler"/> that records every request and answers from a callback.</summary>
public sealed class MockHandler(Func<RecordedRequest, Task<HttpResponseMessage>> respond) : HttpMessageHandler
{
    private readonly object _lock = new();
    private readonly List<RecordedRequest> _requests = [];

    public MockHandler(Func<RecordedRequest, HttpResponseMessage> respond)
        : this(request => Task.FromResult(respond(request)))
    {
    }

    public IReadOnlyList<RecordedRequest> Requests
    {
        get
        {
            lock (_lock) return [.. _requests];
        }
    }

    public IReadOnlyList<RecordedRequest> TokenRequests => [.. Requests.Where(r => r.IsToken)];

    public IReadOnlyList<RecordedRequest> ApiRequests => [.. Requests.Where(r => !r.IsToken)];

    public static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, values) in request.Headers) headers[name] = string.Join(", ", values);
        if (request.Content is not null)
        {
            foreach (var (name, values) in request.Content.Headers) headers[name] = string.Join(", ", values);
        }
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);

        var recorded = new RecordedRequest(request.Method, request.RequestUri!, headers, body);
        lock (_lock) _requests.Add(recorded);
        return await respond(recorded);
    }
}
