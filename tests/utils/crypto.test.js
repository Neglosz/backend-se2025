const { encrypt, decrypt } = require('../../utils/crypto');

describe('utils/crypto key validation', () => {
    const original = process.env.ENCRYPTION_KEY;

    afterEach(() => {
        process.env.ENCRYPTION_KEY = original;
        jest.resetModules();
    });

    /** Load the module fresh with a specific key. */
    function loadWith(key) {
        jest.resetModules();
        if (key === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = key;
        return () => require('../../utils/crypto');
    }

    it('refuses to load when the key is missing, naming the variable', () => {
        expect(loadWith(undefined)).toThrow(/ENCRYPTION_KEY is not set/);
    });

    it('refuses to load when the key is the wrong length, reporting the actual size', () => {
        expect(loadWith('too-short')).toThrow(/must be exactly 32 bytes/);
        expect(loadWith('too-short')).toThrow(/is 9 bytes/);
    });

    it('rejects the 43-byte placeholder that used to be the silent default', () => {
        expect(loadWith('default_secret_key_must_be_32_bytes_long_!!')).toThrow(/43 bytes/);
    });

    it('tells the operator how to generate a valid key', () => {
        expect(loadWith(undefined)).toThrow(/randomBytes\(24\)/);
    });

    it('counts bytes, not characters, so multi-byte keys are rejected', () => {
        // 32 Thai characters are 96 bytes in UTF-8.
        expect(loadWith('ก'.repeat(32))).toThrow(/is 96 bytes/);
    });

    it('loads with a valid 32-byte key', () => {
        const load = loadWith('abcdefghijklmnopqrstuvwxyz123456');
        expect(load).not.toThrow();
        const { encrypt: enc, decrypt: dec } = load();
        expect(dec(enc('hello'))).toBe('hello');
    });
});

describe('utils/crypto', () => {
    describe('encrypt()', () => {
        it('returns null for falsy input', () => {
            expect(encrypt('')).toBeNull();
            expect(encrypt(null)).toBeNull();
            expect(encrypt(undefined)).toBeNull();
        });

        it('returns "<iv-hex>:<cipher-hex>" with a 16-byte IV', () => {
            const out = encrypt('0812345678');
            const [ivHex, cipherHex] = out.split(':');

            expect(out).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
            expect(ivHex).toHaveLength(32); // 16 bytes hex-encoded
            expect(cipherHex.length).toBeGreaterThan(0);
        });

        it('never leaks the plaintext into the ciphertext', () => {
            expect(encrypt('promptpay-secret')).not.toContain('promptpay-secret');
        });

        it('produces a different ciphertext each call (random IV)', () => {
            expect(encrypt('same-input')).not.toBe(encrypt('same-input'));
        });
    });

    describe('decrypt()', () => {
        it('returns null for falsy input', () => {
            expect(decrypt('')).toBeNull();
            expect(decrypt(null)).toBeNull();
            expect(decrypt(undefined)).toBeNull();
        });

        it('round-trips a value through encrypt()', () => {
            const plain = '1234567890123';
            expect(decrypt(encrypt(plain))).toBe(plain);
        });

        it('round-trips Thai text and other multi-byte characters', () => {
            const plain = 'ร้านค้า ทดสอบ ๑๒๓';
            expect(decrypt(encrypt(plain))).toBe(plain);
        });

        it('round-trips a value that itself contains colons', () => {
            const plain = 'a:b:c:d';
            expect(decrypt(encrypt(plain))).toBe(plain);
        });

        it('returns null instead of throwing on malformed input', () => {
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

            expect(decrypt('not-encrypted-at-all')).toBeNull();
            expect(decrypt('zzzz:zzzz')).toBeNull();
            expect(decrypt(':')).toBeNull();

            spy.mockRestore();
        });

        it('returns null when the ciphertext was tampered with', () => {
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const [iv, cipher] = encrypt('sensitive').split(':');
            const flipped = cipher.startsWith('0') ? `1${cipher.slice(1)}` : `0${cipher.slice(1)}`;

            expect(decrypt(`${iv}:${flipped}`)).toBeNull();

            spy.mockRestore();
        });
    });
});
