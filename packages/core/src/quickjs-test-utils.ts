// QuickJS (the native Android app's engine) refuses a call with more than 65535 arguments, so `list.push(...rows)` throws a
// RangeError there for a large import while V8, JSC and the host tests pass it. Runs [work] with push held to that limit.
export const QUICKJS_MAX_CALL_ARGUMENTS = 65_535;

export const withQuickJsPushLimit = <T>(work: () => T): T => {
    const push = Array.prototype.push;
    Array.prototype.push = function limitedPush(this: unknown[], ...items: unknown[]) {
        if (items.length > QUICKJS_MAX_CALL_ARGUMENTS) {
            throw new RangeError(`too many arguments in function call (only ${QUICKJS_MAX_CALL_ARGUMENTS} allowed)`);
        }
        return push.apply(this, items);
    };
    try {
        return work();
    } finally {
        Array.prototype.push = push;
    }
};
