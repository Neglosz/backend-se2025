const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY_BYTES = 32; // aes-256 takes a 32-byte key, no more and no less
const IV_LENGTH = 16; // For AES, this is always 16

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// Fail at boot rather than per request. The previous fallback was 43 bytes long, so a
// missing ENCRYPTION_KEY did not fall back to anything usable — createCipheriv threw
// on every single call, and the store owner saw an opaque 500 instead of a
// misconfiguration.
if (!ENCRYPTION_KEY) {
    throw new Error(
        'ENCRYPTION_KEY is not set. It must be exactly 32 bytes (32 ASCII characters). '
        + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'
    );
}

if (Buffer.byteLength(ENCRYPTION_KEY) !== KEY_BYTES) {
    throw new Error(
        `ENCRYPTION_KEY must be exactly ${KEY_BYTES} bytes for ${ALGORITHM}, `
        + `but the configured value is ${Buffer.byteLength(ENCRYPTION_KEY)} bytes. `
        + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'
    );
}

function encrypt(text) {
    if (!text) return null;
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return null;
    try {
        let textParts = text.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error('Decryption error:', error);
        return null;
    }
}

module.exports = { encrypt, decrypt };
