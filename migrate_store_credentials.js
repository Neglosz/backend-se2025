/**
 * Re-encrypt store_credentials rows that still hold the old XOR obfuscation.
 *
 * The app used to "encrypt" manager passwords by XOR-ing them against a key that
 * shipped inside the mobile bundle, then base64 the result. Those rows cannot be read
 * by utils/crypto, so GET /api/branches/:storeId/credentials returns a null password
 * and the owner has to reset that branch by hand. This converts them in place.
 *
 *   node migrate_store_credentials.js            # dry run, reports what it would do
 *   node migrate_store_credentials.js --apply    # actually writes
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (RLS is bypassed), and
 * ENCRYPTION_KEY — the same one the server runs with, or the rows it writes will be
 * unreadable in production.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { encrypt, decrypt } = require('./utils/crypto');

/** The key that used to ship inside the mobile bundle. */
const LEGACY_KEY = 'yourpos-secret-key-2026';

/** AES output from utils/crypto looks like "<32 hex>:<hex>". */
const AES_FORMAT = /^[0-9a-f]{32}:[0-9a-f]+$/;

/**
 * Classify a stored value so each row is handled once and only once.
 * @returns {'aes'|'legacy-xor'|'empty'|'unknown'}
 */
function classify(stored) {
    if (!stored || !String(stored).trim()) return 'empty';
    const value = String(stored);
    if (AES_FORMAT.test(value)) return 'aes';
    // base64 alphabet only — the XOR scheme produced exactly this
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return 'legacy-xor';
    return 'unknown';
}

/** Reverse the legacy XOR+base64 obfuscation. Returns null if it does not decode. */
function decodeLegacy(stored) {
    try {
        const xored = Buffer.from(String(stored), 'base64').toString('binary');
        if (!xored) return null;
        let plain = '';
        for (let i = 0; i < xored.length; i++) {
            plain += String.fromCharCode(xored.charCodeAt(i) ^ LEGACY_KEY.charCodeAt(i % LEGACY_KEY.length));
        }
        // A recovered password should be printable ASCII; anything else means the
        // value was never XOR-encoded and must be left alone.
        if (!/^[\x20-\x7e]+$/.test(plain)) return null;
        return plain;
    } catch {
        return null;
    }
}

async function migrate({ apply = false, client } = {}) {
    const supabaseAdmin = client || createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const summary = { total: 0, alreadyAes: 0, converted: 0, skipped: 0, failed: 0 };

    const { data: rows, error } = await supabaseAdmin
        .from('store_credentials')
        .select('store_id, email, password_encrypted');

    if (error) {
        console.error('Could not read store_credentials:', error.message || error);
        return { ...summary, error };
    }

    summary.total = rows?.length || 0;

    for (const row of rows || []) {
        const kind = classify(row.password_encrypted);

        if (kind === 'aes') {
            // Confirm it really decrypts with the current key before calling it done.
            if (decrypt(row.password_encrypted) === null) {
                console.warn(`store ${row.store_id}: AES value does not decrypt with the current ENCRYPTION_KEY`);
                summary.failed++;
            } else {
                summary.alreadyAes++;
            }
            continue;
        }

        if (kind !== 'legacy-xor') {
            console.warn(`store ${row.store_id}: skipped (${kind} value)`);
            summary.skipped++;
            continue;
        }

        const plain = decodeLegacy(row.password_encrypted);
        if (!plain) {
            console.warn(`store ${row.store_id}: legacy value did not decode to a printable password`);
            summary.failed++;
            continue;
        }

        if (!apply) {
            console.log(`store ${row.store_id}: would re-encrypt (${row.email})`);
            summary.converted++;
            continue;
        }

        const { error: updateError } = await supabaseAdmin
            .from('store_credentials')
            .update({ password_encrypted: encrypt(plain) })
            .eq('store_id', row.store_id);

        if (updateError) {
            console.error(`store ${row.store_id}: update failed —`, updateError.message || updateError);
            summary.failed++;
        } else {
            console.log(`store ${row.store_id}: re-encrypted (${row.email})`);
            summary.converted++;
        }
    }

    return summary;
}

async function main() {
    const apply = process.argv.includes('--apply');

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
        process.exit(1);
    }

    console.log(apply
        ? 'Re-encrypting legacy store_credentials rows...'
        : 'DRY RUN — nothing will be written. Re-run with --apply to convert.');

    const summary = await migrate({ apply });

    console.log('\nSummary');
    console.log(`  rows read       ${summary.total}`);
    console.log(`  already AES     ${summary.alreadyAes}`);
    console.log(`  ${apply ? 'converted      ' : 'would convert  '} ${summary.converted}`);
    console.log(`  skipped         ${summary.skipped}`);
    console.log(`  failed          ${summary.failed}`);

    if (!apply && summary.converted > 0) {
        console.log('\nRe-run with --apply to write these changes.');
    }
    if (summary.failed > 0) {
        console.log('\nRows that failed still return a null password; those branches need a manual credential reset.');
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error('Migration crashed:', e);
        process.exit(1);
    });
}

module.exports = { migrate, classify, decodeLegacy, LEGACY_KEY };
