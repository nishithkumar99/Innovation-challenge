package de.smartcare.core.api;

/** Error with an HTTP status code, mapped to a JSON error body by the web layer. */
public final class ApiException extends RuntimeException {
    public final int status;
    public ApiException(int status, String message) { super(message); this.status = status; }
    public static ApiException forbidden(String m) { return new ApiException(403, m); }
    public static ApiException badRequest(String m) { return new ApiException(400, m); }
    public static ApiException notFound(String m) { return new ApiException(404, m); }
}
