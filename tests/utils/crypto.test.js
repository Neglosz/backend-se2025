const { encrypt, decrypt } = require('../../utils/crypto');

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
