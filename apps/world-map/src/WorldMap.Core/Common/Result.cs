namespace WorldMap.Core.Common;

/// <summary>A single field-level validation error (maps to ProblemDetails.errors[]).</summary>
public sealed record FieldError(string Pointer, string Detail);

/// <summary>
/// Immutable description of a failure. Carries the internal <see cref="ErrorCode"/>,
/// a human-readable message, a <see cref="Retryable"/> hint, and optional field
/// errors. The stable wire <c>code</c> string and HTTP status are derived in the
/// API layer via <c>ProblemMapping</c> so the domain stays transport-agnostic.
/// </summary>
public sealed record ErrorInfo(
    ErrorCode Code,
    string Message,
    bool Retryable = false,
    IReadOnlyList<FieldError>? Errors = null);

/// <summary>
/// Factory for <see cref="ErrorInfo"/>. Mirrors the team pattern where a service
/// returns <c>ErrorResult.Create(...)</c> which implicitly converts to any
/// <see cref="Result{T}"/>.
/// </summary>
public static class ErrorResult
{
    public static ErrorInfo Create(
        ErrorCode code,
        string message,
        bool retryable = false,
        IReadOnlyList<FieldError>? errors = null)
        => new(code, message, retryable, errors);
}

/// <summary>
/// Discriminated success/failure result. Success carries a <typeparamref name="T"/>
/// value; failure carries an <see cref="ErrorInfo"/>. Never throws for expected
/// business failures — callers branch on <see cref="IsSuccess"/>.
/// </summary>
public readonly struct Result<T>
{
    private readonly T? _value;
    private readonly ErrorInfo? _error;

    private Result(T value)
    {
        _value = value;
        _error = null;
        IsSuccess = true;
    }

    private Result(ErrorInfo error)
    {
        _value = default;
        _error = error;
        IsSuccess = false;
    }

    public bool IsSuccess { get; }

    /// <summary>The success value. Throws if accessed on a failure result.</summary>
    public T Value => IsSuccess
        ? _value!
        : throw new InvalidOperationException("Cannot access Value of a failed Result.");

    /// <summary>The failure info. Throws if accessed on a success result.</summary>
    public ErrorInfo Error => IsSuccess
        ? throw new InvalidOperationException("Cannot access Error of a successful Result.")
        : _error!;

    public static Result<T> Success(T value) => new(value);
    public static Result<T> Failure(ErrorInfo error) => new(error);

    public static implicit operator Result<T>(T value) => new(value);
    public static implicit operator Result<T>(ErrorInfo error) => new(error);
}
