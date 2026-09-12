const mockGetUser = jest.fn();

// auth.js builds its own Supabase client at require time, so the module is mocked
// before the middleware is loaded.
jest.mock('@supabase/supabase-js', () => ({
    createClient: jest.fn(() => ({ auth: { getUser: mockGetUser } }))
}));

const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../../middleware/auth');

// The client is built once, at require time. Snapshot the arguments now, before
// `clearMocks` wipes the call history ahead of the first test.
const createClientCalls = createClient.mock.calls.map((args) => [...args]);

function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

describe('middleware/auth', () => {
    beforeEach(() => {
        mockGetUser.mockReset();
    });

    it('builds its Supabase client from the anon key, never the service role key', () => {
        expect(createClientCalls).toContainEqual([process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY]);
        expect(createClientCalls.some(([, key]) => key === process.env.SUPABASE_SERVICE_ROLE_KEY)).toBe(false);
    });

    it('rejects a request with no Authorization header', async () => {
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware({ headers: {} }, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Missing Authorization Header' });
        expect(next).not.toHaveBeenCalled();
        expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('rejects an Authorization header with no token after the scheme', async () => {
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware({ headers: { authorization: 'Bearer' } }, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid Token Format' });
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects when Supabase reports an auth error', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError', message: 'bad jwt' } });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware({ headers: { authorization: 'Bearer bad-token' } }, res, next);

        expect(mockGetUser).toHaveBeenCalledWith('bad-token');
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid or Expired Token' });
        expect(next).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('rejects when Supabase returns no user and no error', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware({ headers: { authorization: 'Bearer stale' } }, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('does not log an expired-session error (expected, would spam logs)', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = mockRes();

        await authMiddleware({ headers: { authorization: 'Bearer expired' } }, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(401);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('attaches the user and calls next() on a valid token', async () => {
        const user = { id: 'user-1', email: 'owner@test.dev' };
        mockGetUser.mockResolvedValue({ data: { user }, error: null });
        const req = { headers: { authorization: 'Bearer good-token' } };
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(req.user).toBe(user);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    it('accepts extra whitespace-separated parts, taking the second as the token', async () => {
        mockGetUser.mockResolvedValue({ data: { user: { id: 'u' } }, error: null });

        await authMiddleware({ headers: { authorization: 'Bearer tok extra' } }, mockRes(), jest.fn());

        expect(mockGetUser).toHaveBeenCalledWith('tok');
    });

    it('returns 500 when the Supabase call throws', async () => {
        mockGetUser.mockRejectedValue(new Error('network down'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware({ headers: { authorization: 'Bearer any' } }, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Internal Server Error' });
        expect(next).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('never leaks the underlying error message to the client', async () => {
        mockGetUser.mockRejectedValue(new Error('postgres://user:password@host'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = mockRes();

        await authMiddleware({ headers: { authorization: 'Bearer any' } }, res, jest.fn());

        const body = JSON.stringify(res.json.mock.calls[0][0]);
        expect(body).not.toContain('password');
        spy.mockRestore();
    });
});
