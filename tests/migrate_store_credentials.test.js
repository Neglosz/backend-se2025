const { migrate, classify, decodeLegacy, LEGACY_KEY } = require('../migrate_store_credentials');
const { encrypt, decrypt } = require('../utils/crypto');
const { createMockSupabase, filterArgs } = require('./helpers/mockSupabase');

/** Re-create the obfuscation the mobile bundle used to apply. */
function legacyEncode(password) {
    let xored = '';
    for (let i = 0; i < password.length; i++) {
        xored += String.fromCharCode(password.charCodeAt(i) ^ LEGACY_KEY.charCodeAt(i % LEGACY_KEY.length));
    }
    return Buffer.from(xored, 'binary').toString('base64');
}

describe('migrate_store_credentials', () => {
    let logSpy;
    let warnSpy;
    let errorSpy;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    describe('classify()', () => {
        it('recognises the AES format utils/crypto produces', () => {
            expect(classify(encrypt('secret123'))).toBe('aes');
        });

        it('recognises the legacy XOR+base64 format', () => {
            expect(classify(legacyEncode('secret123'))).toBe('legacy-xor');
        });

        it('reports an empty value', () => {
            expect(classify(null)).toBe('empty');
            expect(classify('')).toBe('empty');
            expect(classify('   ')).toBe('empty');
        });

        it('reports anything else as unknown rather than guessing', () => {
            expect(classify('plain password!')).toBe('unknown');
            expect(classify('deadbeef:notlowerhex!')).toBe('unknown');
        });
    });

    describe('decodeLegacy()', () => {
        it('recovers a password encoded by the old scheme', () => {
            expect(decodeLegacy(legacyEncode('Manager@2026'))).toBe('Manager@2026');
        });

        it('round-trips the character set the app generated', () => {
            const generated = 'AbCdEfGh23';
            expect(decodeLegacy(legacyEncode(generated))).toBe(generated);
        });

        it('handles a password longer than the legacy key', () => {
            const long = 'x'.repeat(60);
            expect(decodeLegacy(legacyEncode(long))).toBe(long);
        });

        it('returns null when the value does not decode to printable text', () => {
            // Bytes chosen so the XOR lands on control characters — a value that was
            // never produced by the legacy scheme must not be "recovered" as garbage.
            const controlChars = Buffer.from([
                LEGACY_KEY.charCodeAt(0) ^ 0x01,
                LEGACY_KEY.charCodeAt(1) ^ 0x02,
                LEGACY_KEY.charCodeAt(2) ^ 0x00
            ]).toString('base64');

            expect(decodeLegacy(controlChars)).toBeNull();
            expect(decodeLegacy('')).toBeNull();
        });
    });

    describe('migrate()', () => {
        /** A mock holding the given store_credentials rows. */
        function withRows(rows) {
            const db = createMockSupabase();
            db.on('store_credentials', (state) => (state.op === 'select'
                ? { data: rows, error: null }
                : { data: null, error: null }));
            return db;
        }

        it('reports what it would do without writing anything on a dry run', async () => {
            const db = withRows([
                { store_id: 's1', email: 'a@b.c', password_encrypted: legacyEncode('secret123') }
            ]);

            const summary = await migrate({ apply: false, client: db });

            expect(summary).toMatchObject({ total: 1, converted: 1, alreadyAes: 0, failed: 0 });
            expect(db.callsForOp('store_credentials', 'update')).toHaveLength(0);
        });

        it('re-encrypts a legacy row with the current key when applied', async () => {
            const db = withRows([
                { store_id: 's1', email: 'a@b.c', password_encrypted: legacyEncode('secret123') }
            ]);

            const summary = await migrate({ apply: true, client: db });

            expect(summary).toMatchObject({ total: 1, converted: 1, failed: 0 });

            const [update] = db.callsForOp('store_credentials', 'update');
            expect(filterArgs(update, 'eq')).toContainEqual(['store_id', 's1']);
            expect(decrypt(update.payload.password_encrypted)).toBe('secret123');
            expect(update.payload.password_encrypted).not.toBe(legacyEncode('secret123'));
        });

        it('leaves a row that is already AES alone', async () => {
            const db = withRows([
                { store_id: 's1', email: 'a@b.c', password_encrypted: encrypt('secret123') }
            ]);

            const summary = await migrate({ apply: true, client: db });

            expect(summary).toMatchObject({ alreadyAes: 1, converted: 0, failed: 0 });
            expect(db.callsForOp('store_credentials', 'update')).toHaveLength(0);
        });

        it('flags an AES row that the current key cannot decrypt instead of destroying it', async () => {
            // e.g. the key was rotated without migrating.
            const db = withRows([
                { store_id: 's1', email: 'a@b.c', password_encrypted: `${'0'.repeat(32)}:abcdef` }
            ]);

            const summary = await migrate({ apply: true, client: db });

            expect(summary).toMatchObject({ failed: 1, alreadyAes: 0, converted: 0 });
            expect(db.callsForOp('store_credentials', 'update')).toHaveLength(0);
        });

        it('skips empty and unrecognised values', async () => {
            const db = withRows([
                { store_id: 's1', email: 'a@b.c', password_encrypted: null },
                { store_id: 's2', email: 'd@e.f', password_encrypted: 'plain text password' }
            ]);

            const summary = await migrate({ apply: true, client: db });

            expect(summary).toMatchObject({ total: 2, skipped: 2, converted: 0 });
            expect(db.callsForOp('store_credentials', 'update')).toHaveLength(0);
        });

        it('converts several rows and keeps counting when one fails', async () => {
            const db = createMockSupabase();
            db.on('store_credentials', (state) => {
                if (state.op === 'select') {
                    return {
                        data: [
                            { store_id: 's1', email: 'a@b.c', password_encrypted: legacyEncode('one') },
                            { store_id: 's2', email: 'd@e.f', password_encrypted: legacyEncode('two') }
                        ],
                        error: null
                    };
                }
                const target = filterArgs(state, 'eq').find(([col]) => col === 'store_id');
                return target?.[1] === 's2'
                    ? { data: null, error: { message: 'row locked' } }
                    : { data: null, error: null };
            });

            const summary = await migrate({ apply: true, client: db });

            expect(summary).toMatchObject({ total: 2, converted: 1, failed: 1 });
        });

        it('reports a read failure instead of pretending there was nothing to do', async () => {
            const db = createMockSupabase();
            db.on('store_credentials', { data: null, error: { message: 'permission denied' } });

            const summary = await migrate({ apply: true, client: db });

            expect(summary.error).toBeTruthy();
            expect(summary.converted).toBe(0);
        });

        it('handles an empty table', async () => {
            const summary = await migrate({ apply: true, client: withRows([]) });

            expect(summary).toMatchObject({ total: 0, converted: 0, failed: 0 });
        });
    });
});
