/**
 * Chainable in-memory stand-in for the Supabase JS client.
 *
 * The real client builds a query with a fluent chain and only executes it when the
 * chain is awaited (it is a thenable) or when a terminal method such as `.single()`
 * is called. This mock mirrors that shape so route handlers can be exercised without
 * a database.
 *
 * Resolution order for `from(table)` chains:
 *   1. a queued result for that table (FIFO, via `queue`)
 *   2. a handler registered for that table (via `on`), called with the chain state
 *   3. the default `{ data: null, error: null }`
 *
 * Every chain is recorded in `db.calls` so tests can assert on the query that was
 * built (table, operation, filters, payloads) instead of only on the HTTP response.
 */

const CHAINABLE = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not',
    'like', 'ilike', 'or', 'filter', 'match', 'order', 'range', 'limit',
    'contains', 'overlaps', 'textSearch', 'throwOnError'
];

const TERMINAL = ['single', 'maybeSingle', 'csv'];

function createMockSupabase(initial = {}) {
    const queues = new Map();      // table -> array of results
    const handlers = new Map();    // table -> (state) => result
    const calls = [];              // every completed chain

    for (const [table, value] of Object.entries(initial)) {
        if (typeof value === 'function') {
            handlers.set(table, value);
        } else if (Array.isArray(value)) {
            queues.set(table, [...value]);
        } else {
            handlers.set(table, () => value);
        }
    }

    const defaultResult = { data: null, error: null };
    let fallbackHandler = null;

    function resolveFor(state) {
        const queue = queues.get(state.table);
        if (queue && queue.length > 0) return queue.shift();
        const handler = handlers.get(state.table);
        if (handler) return handler(state) || defaultResult;
        if (fallbackHandler) return fallbackHandler(state) || defaultResult;
        return defaultResult;
    }

    function normalize(result, state) {
        const base = { data: null, error: null, count: null, status: 200, ...result };
        // `.single()` unwraps a one-row array the way PostgREST does.
        if (state.terminal === 'single' || state.terminal === 'maybeSingle') {
            if (Array.isArray(base.data)) base.data = base.data[0] ?? null;
        }
        return base;
    }

    function createBuilder(table) {
        const state = {
            table,
            op: null,          // select | insert | update | upsert | delete
            ops: [],           // full ordered chain, for assertions
            filters: [],       // only the filter links
            payload: undefined,
            selectArgs: undefined,
            terminal: null
        };

        const builder = {
            __state: state,
            then(onFulfilled, onRejected) {
                const result = normalize(resolveFor(state), state);
                calls.push(state);
                return Promise.resolve(result).then(onFulfilled, onRejected);
            },
            catch(onRejected) {
                return builder.then(undefined, onRejected);
            },
            finally(onFinally) {
                return builder.then().finally(onFinally);
            }
        };

        for (const name of CHAINABLE) {
            builder[name] = (...args) => {
                state.ops.push({ name, args });
                if (['select', 'insert', 'update', 'upsert', 'delete'].includes(name)) {
                    // A trailing `.select()` after a write is a projection, not the operation.
                    if (!state.op || name !== 'select') state.op = name;
                    if (['insert', 'update', 'upsert'].includes(name)) state.payload = args[0];
                    if (name === 'select') state.selectArgs = args;
                } else {
                    state.filters.push({ name, args });
                }
                return builder;
            };
        }

        for (const name of TERMINAL) {
            builder[name] = () => {
                state.terminal = name;
                state.ops.push({ name, args: [] });
                const result = normalize(resolveFor(state), state);
                calls.push(state);
                return Promise.resolve(result);
            };
        }

        return builder;
    }

    const storageBuckets = new Map();

    function storageFrom(bucket) {
        const api = storageBuckets.get(bucket) || {};
        return {
            upload: jest.fn(api.upload || (async () => ({ data: { path: 'uploaded/path' }, error: null }))),
            remove: jest.fn(api.remove || (async () => ({ data: [], error: null }))),
            getPublicUrl: jest.fn(api.getPublicUrl || ((path) => ({
                data: { publicUrl: `https://cdn.test/object/public/${bucket}/${path}` }
            }))),
            createSignedUrl: jest.fn(api.createSignedUrl || (async (path) => ({
                data: { signedUrl: `https://cdn.test/signed/${bucket}/${path}` },
                error: null
            })))
        };
    }

    const db = {
        from: jest.fn(createBuilder),
        rpc: jest.fn(async () => ({ ...defaultResult })),
        storage: { from: jest.fn(storageFrom) },
        auth: {
            getUser: jest.fn(async () => ({ data: { user: null }, error: null })),
            admin: {
                createUser: jest.fn(async () => ({ data: { user: { id: 'new-user-id' } }, error: null })),
                deleteUser: jest.fn(async () => ({ data: null, error: null })),
                updateUserById: jest.fn(async () => ({ data: { user: { id: 'user-id' } }, error: null }))
            }
        },

        calls,

        /** Queue one result for the next chain that touches `table` (FIFO). */
        queue(table, ...results) {
            const existing = queues.get(table) || [];
            queues.set(table, existing.concat(results));
            return db;
        },
        /** Register a handler that answers every chain on `table`. */
        on(table, handler) {
            handlers.set(table, typeof handler === 'function' ? handler : () => handler);
            return db;
        },
        /**
         * Answer any table that has no queue and no handler of its own. Useful for
         * modules that touch dozens of tables in one request.
         */
        onDefault(handler) {
            fallbackHandler = handler === null
                ? null
                : (typeof handler === 'function' ? handler : () => handler);
            return db;
        },
        /** Configure the storage API for one bucket. */
        setStorage(bucket, api) {
            storageBuckets.set(bucket, api);
            return db;
        },
        /** All recorded chains for a table. */
        callsFor(table) {
            return calls.filter((c) => c.table === table);
        },
        /** Recorded chains for a table narrowed to one operation. */
        callsForOp(table, op) {
            return calls.filter((c) => c.table === table && c.op === op);
        },
        /** Value passed to the first filter of `name` in a chain state. */
        reset() {
            queues.clear();
            handlers.clear();
            storageBuckets.clear();
            fallbackHandler = null;
            calls.length = 0;
            return db;
        }
    };

    return db;
}

/** Read the argument of a named filter out of a recorded chain. */
function filterArgs(call, name) {
    const found = call.filters.filter((f) => f.name === name);
    return found.map((f) => f.args);
}

module.exports = { createMockSupabase, filterArgs };
