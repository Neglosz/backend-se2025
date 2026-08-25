// migrate_due_date.js is a run-once script: requiring it builds a Supabase client and
// immediately invokes migrate(). Each test therefore loads it in a fresh module
// registry with the Supabase module and process.exit stubbed out.
const mockCreateClient = jest.fn();

jest.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }));
// The script loads ../pos_application/.env, which really exists in this repo and
// would repopulate the variables these tests deliberately unset.
jest.mock('dotenv', () => ({ config: jest.fn() }));

const SCRIPT = '../migrate_due_date';

/** Load the script fresh and let its async migrate() settle. */
async function runScript() {
    jest.resetModules();
    require(SCRIPT);
    await new Promise((resolve) => setImmediate(resolve));
}

/** A client whose customers_info probe resolves with `result`. */
function clientReturning(result) {
    const head = jest.fn(async () => result);
    const select = jest.fn(() => ({ then: (onOk, onErr) => head().then(onOk, onErr) }));
    const from = jest.fn(() => ({ select }));
    return { client: { from }, from, select };
}

describe('migrate_due_date.js', () => {
    let logSpy;
    let errorSpy;
    let exitSpy;
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit called');
        });
        mockCreateClient.mockReset();
    });

    afterEach(() => {
        process.env = originalEnv;
        logSpy.mockRestore();
        errorSpy.mockRestore();
        exitSpy.mockRestore();
    });

    it('builds the client from the EXPO_PUBLIC_* environment variables', async () => {
        mockCreateClient.mockReturnValue(clientReturning({ data: null, error: null }).client);

        await runScript();

        expect(mockCreateClient).toHaveBeenCalledWith('http://localhost:54321', 'anon-key');
    });

    it('exits with code 1 when the URL or key is missing', async () => {
        for (const missing of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']) {
            process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
            process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
            delete process.env[missing];

            // eslint-disable-next-line no-await-in-loop
            await expect(runScript()).rejects.toThrow('process.exit called');
            expect(errorSpy).toHaveBeenCalledWith('Missing Supabase URL or Key');
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(mockCreateClient).not.toHaveBeenCalled();
        }
    });

    it('probes customers_info with a head-only exact count', async () => {
        const stub = clientReturning({ data: null, error: null });
        mockCreateClient.mockReturnValue(stub.client);

        await runScript();

        expect(stub.from).toHaveBeenCalledWith('customers_info');
        expect(stub.select).toHaveBeenCalledWith('count', { count: 'exact', head: true });
    });

    it('prints the SQL the operator must run when the connection works', async () => {
        mockCreateClient.mockReturnValue(clientReturning({ data: null, error: null }).client);

        await runScript();

        const output = logSpy.mock.calls.flat().join('\n');
        expect(output).toContain('Connection successful');
        expect(output).toContain('ALTER TABLE customers_info ADD COLUMN IF NOT EXISTS due_date DATE;');
        expect(output).toContain('UPDATE customers_info c');
        expect(output).toContain('MAX(due_date) as max_due_date');
    });

    it('stops after reporting a failed connection, printing no SQL', async () => {
        mockCreateClient.mockReturnValue(clientReturning({ data: null, error: { message: 'refused' } }).client);

        await runScript();

        expect(errorSpy).toHaveBeenCalledWith('Connection failed:', { message: 'refused' });
        const output = logSpy.mock.calls.flat().join('\n');
        expect(output).not.toContain('ALTER TABLE');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('is advisory only - it never writes to the database itself', async () => {
        const stub = clientReturning({ data: null, error: null });
        mockCreateClient.mockReturnValue(stub.client);

        await runScript();

        // The only table access is the read-only probe; the migration itself is left
        // to the operator to paste into the Supabase SQL editor.
        expect(stub.from).toHaveBeenCalledTimes(1);
    });
});
