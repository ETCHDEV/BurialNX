# `splash.ts`

Drawn before any other init so the user sees immediate feedback that the loader is alive. If a later step throws during module evaluation, `fatal()` replaces the splash with the error so the user is never stuck on a black screen with no diagnostic.

## File header
> === Splash + fatal-error helpers ====================================
> Extracted from main.ts. Drawn before any other init so the user sees
> immediate feedback that the loader is alive. If a later step throws
> during module evaluation, fatal() replaces the splash with the error
> so the user is never stuck on a black screen with no diagnostic.
>
> `ctx` is passed in at the call site (main.ts owns the single 2D context).
> `hostLogPath` is imported from the log module so the path stays the
> single source of truth.
