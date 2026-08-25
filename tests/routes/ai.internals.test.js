// ai.js builds a Gemini client and an admin Supabase client at require time, so both
// modules are replaced before the router is loaded.
let mockDb;
const mockGetGenerativeModel = jest.fn();

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockDb) }));
jest.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: jest.fn(() => ({ getGenerativeModel: mockGetGenerativeModel }))
}));

const { createMockSupabase } = require('../helpers/mockSupabase');
mockDb = createMockSupabase();

const aiRoutes = require('../../routes/ai');
const {
    levenshtein,
    fuzzyScore,
    fuzzyMatchProducts,
    roundPriceTo5,
    retryWithBackoff,
    checkChatRateLimit,
    getRealAddress,
    getWeatherData
} = aiRoutes._internals;

describe('routes/ai internals', () => {
    describe('levenshtein()', () => {
        it('is zero for identical strings', () => {
            expect(levenshtein('', '')).toBe(0);
            expect(levenshtein('นมสด', 'นมสด')).toBe(0);
        });

        it('equals the other string length when one side is empty', () => {
            expect(levenshtein('', 'abc')).toBe(3);
            expect(levenshtein('abc', '')).toBe(3);
        });

        it('counts a single substitution, insertion or deletion as one edit', () => {
            expect(levenshtein('cat', 'bat')).toBe(1);
            expect(levenshtein('cat', 'cats')).toBe(1);
            expect(levenshtein('cats', 'cat')).toBe(1);
        });

        it('counts the classic multi-edit distances', () => {
            expect(levenshtein('kitten', 'sitting')).toBe(3);
            expect(levenshtein('flaw', 'lawn')).toBe(2);
        });

        it('is symmetric', () => {
            expect(levenshtein('coke', 'cola')).toBe(levenshtein('cola', 'coke'));
        });

        it('works on Thai text, counting combining marks as their own units', () => {
            expect(levenshtein('น้ำเปล่า', 'น้ำแข็ง')).toBeGreaterThan(0);
            // 'นมสด' is 4 code units; 'นมส้ม' is 5 (the tone mark counts separately),
            // so this is one insertion plus one substitution.
            expect(levenshtein('นมสด', 'นมส้ม')).toBe(2);
        });
    });

    describe('fuzzyScore()', () => {
        it('scores a perfect 1.0 for an exact match', () => {
            expect(fuzzyScore('นมสด', 'นมสด')).toBe(1);
        });

        it('scores 1.0 when either string contains the other', () => {
            expect(fuzzyScore('นม', 'นมสดพาสเจอร์ไรส์')).toBe(1);
            expect(fuzzyScore('coca cola zero', 'cola')).toBe(1);
        });

        it('ignores case and surrounding whitespace', () => {
            expect(fuzzyScore('  Coke  ', 'coke')).toBe(1);
        });

        it('scores partial token overlap between 0 and 1', () => {
            const score = fuzzyScore('เป๊ปซี่ ขวดใหญ่', 'โค้ก ขวดใหญ่');
            expect(score).toBeGreaterThan(0);
            expect(score).toBeLessThan(1);
        });

        it('splits tokens on spaces, dashes, underscores and slashes', () => {
            expect(fuzzyScore('milk-tea', 'milk tea')).toBe(1);
            expect(fuzzyScore('a_b/c', 'a b c')).toBe(1);
        });

        it('falls back to a Levenshtein ratio for a near-miss single token', () => {
            const score = fuzzyScore('pepsi', 'peosi');
            expect(score).toBeCloseTo(0.8);
        });

        it('scores an unrelated pair low', () => {
            expect(fuzzyScore('ผงซักฟอก', 'โค้ก')).toBeLessThan(0.45);
        });

        it('never returns a negative score', () => {
            expect(fuzzyScore('abcdefghij', 'zyxwvutsrq')).toBeGreaterThanOrEqual(0);
        });

        it('treats two empty strings as a match', () => {
            expect(fuzzyScore('', '')).toBe(1);
        });
    });

    describe('fuzzyMatchProducts()', () => {
        const products = [
            { id: 'p1', name: 'นมสดพาสเจอร์ไรส์' },
            { id: 'p2', name: 'โค้ก ขวดใหญ่' },
            { id: 'p3', name: 'ผงซักฟอกบรีส' }
        ];

        it('matches each queried name to its best product', () => {
            const out = fuzzyMatchProducts(['นมสด', 'โค้ก'], products);

            expect(out.map((p) => p.id)).toEqual(['p1', 'p2']);
        });

        it('annotates the match with its score and the name that was queried', () => {
            const [match] = fuzzyMatchProducts(['นมสด'], products);

            expect(match._queriedAs).toBe('นมสด');
            expect(match._fuzzyScore).toBeGreaterThanOrEqual(0.45);
            expect(match.name).toBe('นมสดพาสเจอร์ไรส์');
        });

        it('deduplicates when several queries resolve to the same product', () => {
            const out = fuzzyMatchProducts(['นมสด', 'นมสดพาส'], products);

            expect(out).toHaveLength(1);
            expect(out[0]._queriedAs).toBe('นมสด'); // first query wins
        });

        it('drops matches below the default threshold', () => {
            expect(fuzzyMatchProducts(['xyz123'], products)).toEqual([]);
        });

        it('honours a custom threshold', () => {
            expect(fuzzyMatchProducts(['นมสด'], products, 1.1)).toEqual([]);
            expect(fuzzyMatchProducts(['นมสด'], products, 0.9)).toHaveLength(1);
        });

        it('can still match a zero-scoring query when the threshold is lowered to 0', () => {
            // The best-so-far score starts below zero, so a caller who explicitly opts
            // into threshold 0 gets a candidate instead of an empty list.
            const out = fuzzyMatchProducts(['xyz123'], products, 0);

            expect(out).toHaveLength(1);
            expect(out[0]._fuzzyScore).toBe(0);
        });

        it('still drops a zero-scoring query at the default threshold', () => {
            expect(fuzzyMatchProducts(['xyz123'], products)).toEqual([]);
        });

        it('returns an empty array for empty input on either side', () => {
            expect(fuzzyMatchProducts([], products)).toEqual([]);
            expect(fuzzyMatchProducts(['นมสด'], [])).toEqual([]);
        });

        it('does not mutate the source products', () => {
            const snapshot = JSON.parse(JSON.stringify(products));
            fuzzyMatchProducts(['นมสด'], products);
            expect(products).toEqual(snapshot);
        });
    });

    describe('matchProductsByName()', () => {
        const { matchProductsByName } = aiRoutes._internals;
        const catalogue = [
            { id: 'a', name: 'นม' },
            { id: 'b', name: 'นมสด' },
            { id: 'c', name: 'นมสดพาสเจอร์ไรส์รสจืด' },
            { id: 'd', name: 'ขนมปัง' }
        ];

        it('returns the exact match and nothing else when one exists', () => {
            expect(matchProductsByName(catalogue, ['นมสด']).map((p) => p.id)).toEqual(['b']);
            expect(matchProductsByName(catalogue, ['นม']).map((p) => p.id)).toEqual(['a']);
        });

        it('never lets a short name drag in every product that contains it', () => {
            // The old `includes` sweep matched a, b and c for "นม" and the caller then
            // quoted whichever came first.
            expect(matchProductsByName(catalogue, ['นม'])).toHaveLength(1);
        });

        it('resolves several names at once', () => {
            expect(matchProductsByName(catalogue, ['นมสด', 'ขนมปัง']).map((p) => p.id).sort())
                .toEqual(['b', 'd']);
        });

        it('ignores case and surrounding whitespace on the exact match', () => {
            const latin = [{ id: 'x', name: 'Coca Cola' }, { id: 'y', name: 'Coca Cola Zero' }];
            expect(matchProductsByName(latin, ['  coca cola  ']).map((p) => p.id)).toEqual(['x']);
        });

        it('falls back to the closest substring match when nothing matches exactly', () => {
            const out = matchProductsByName(catalogue, ['นมสดพาส']);
            expect(out).toHaveLength(1);
            expect(out[0].id).toBe('b'); // closest length to the queried name
        });

        it('deduplicates when two queried names resolve to the same product', () => {
            expect(matchProductsByName(catalogue, ['นมสดพาส', 'นมสดพาสเจอร์'])).toHaveLength(1);
        });

        it('returns an empty array for empty input on either side', () => {
            expect(matchProductsByName(catalogue, [])).toEqual([]);
            expect(matchProductsByName([], ['นมสด'])).toEqual([]);
            expect(matchProductsByName(null, null)).toEqual([]);
        });

        it('returns an empty array when nothing resembles the query', () => {
            expect(matchProductsByName(catalogue, ['ผงซักฟอก'])).toEqual([]);
        });
    });

    describe('roundPriceTo5()', () => {
        it('rounds to the nearest multiple of 5', () => {
            expect(roundPriceTo5(16)).toBe(15);
            expect(roundPriceTo5(17)).toBe(15);
            expect(roundPriceTo5(18)).toBe(20);
            expect(roundPriceTo5(52)).toBe(50);
            expect(roundPriceTo5(199)).toBe(200);
        });

        it('leaves an already-round price alone', () => {
            expect(roundPriceTo5(15)).toBe(15);
            expect(roundPriceTo5(200)).toBe(200);
        });

        it('never returns a price below 5', () => {
            expect(roundPriceTo5(1)).toBe(5);
            expect(roundPriceTo5(2.4)).toBe(5);
        });

        it('accepts numeric strings', () => {
            expect(roundPriceTo5('17')).toBe(15);
            expect(roundPriceTo5('18.6')).toBe(20);
        });

        it('returns null for anything that is not a usable price', () => {
            for (const bad of [null, undefined, '', 'abc', 0, -5, NaN]) {
                expect(roundPriceTo5(bad)).toBeNull();
            }
        });
    });

    describe('retryWithBackoff()', () => {
        let logSpy;

        beforeEach(() => {
            logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        });

        afterEach(() => logSpy.mockRestore());

        it('returns the value on the first successful call', async () => {
            const fn = jest.fn(async () => 'ok');

            await expect(retryWithBackoff(fn)).resolves.toBe('ok');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('retries a 429 until it succeeds', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('429 Too Many Requests'))
                .mockResolvedValueOnce('recovered');

            await expect(retryWithBackoff(fn, 3, 1)).resolves.toBe('recovered');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('retries a 503 as well', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('503 Service Unavailable'))
                .mockResolvedValueOnce('recovered');

            await expect(retryWithBackoff(fn, 3, 1)).resolves.toBe('recovered');
        });

        it('rethrows any other error immediately without retrying', async () => {
            const fn = jest.fn().mockRejectedValue(new Error('400 Bad Request'));

            await expect(retryWithBackoff(fn, 3, 1)).rejects.toThrow('400 Bad Request');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('gives up after the retry budget is exhausted', async () => {
            const fn = jest.fn().mockRejectedValue(new Error('429'));

            await expect(retryWithBackoff(fn, 2, 1)).rejects.toThrow('429');
            expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
        });
    });

    describe('checkChatRateLimit()', () => {
        let nowSpy;
        let now;

        beforeEach(() => {
            now = Date.UTC(2025, 2, 12, 3, 0, 0);
            nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
        });

        afterEach(() => nowSpy.mockRestore());

        it('allows the first message from a new user', () => {
            expect(checkChatRateLimit('user-fresh-1')).toBe(true);
        });

        it('allows exactly 20 messages in the window, then refuses', () => {
            const user = 'user-burst';

            for (let i = 0; i < 20; i++) expect(checkChatRateLimit(user)).toBe(true);

            expect(checkChatRateLimit(user)).toBe(false);
            expect(checkChatRateLimit(user)).toBe(false);
        });

        it('resets the budget once the 5 minute window has passed', () => {
            const user = 'user-window';
            for (let i = 0; i < 20; i++) checkChatRateLimit(user);
            expect(checkChatRateLimit(user)).toBe(false);

            now += 5 * 60 * 1000 + 1;

            expect(checkChatRateLimit(user)).toBe(true);
        });

        it('does not reset one millisecond early', () => {
            const user = 'user-edge';
            for (let i = 0; i < 20; i++) checkChatRateLimit(user);

            now += 5 * 60 * 1000; // exactly at resetAt, not past it

            expect(checkChatRateLimit(user)).toBe(false);
        });

        it('tracks each user separately', () => {
            for (let i = 0; i < 20; i++) checkChatRateLimit('user-a');

            expect(checkChatRateLimit('user-a')).toBe(false);
            expect(checkChatRateLimit('user-b')).toBe(true);
        });
    });

    describe('getRealAddress()', () => {
        let errorSpy;

        beforeEach(() => {
            errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            global.fetch = jest.fn();
        });

        afterEach(() => {
            errorSpy.mockRestore();
            delete global.fetch;
        });

        it('returns a placeholder without calling out when coordinates are missing', async () => {
            await expect(getRealAddress(null, 100)).resolves.toBe('Unknown Location');
            await expect(getRealAddress(13.7, null)).resolves.toBe('Unknown Location');
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('builds a "district, city" label from the Nominatim response', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ address: { suburb: 'บางรัก', city: 'กรุงเทพ' } }) });

            await expect(getRealAddress(13.7, 100.5)).resolves.toBe('บางรัก, กรุงเทพ');
        });

        it('falls back through the district and city field aliases', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ address: { city_district: 'เมือง', town: 'ชลบุรี' } }) });

            await expect(getRealAddress(13.7, 100.5)).resolves.toBe('เมือง, ชลบุรี');
        });

        it('sends the User-Agent Nominatim requires, with the coordinates in the URL', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ address: {} }) });

            await getRealAddress(13.75, 100.5);

            const [url, options] = global.fetch.mock.calls[0];
            expect(url).toContain('lat=13.75');
            expect(url).toContain('lon=100.5');
            expect(options.headers['User-Agent']).toBe('SE2025-POS-App');
        });

        it('falls back to "Thailand" when the response has no usable fields', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ address: {} }) });

            await expect(getRealAddress(13.7, 100.5)).resolves.toBe('Thailand');
        });

        it('falls back to "Thailand" when the response has no address block at all', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({}) });

            await expect(getRealAddress(13.7, 100.5)).resolves.toBe('Thailand');
        });

        it('emits just the one part it has, with no dangling comma', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ address: { city: 'กรุงเทพ' } }) });
            await expect(getRealAddress(13.7, 100.5)).resolves.toBe('กรุงเทพ');

            global.fetch.mockResolvedValue({ json: async () => ({ address: { suburb: 'บางรัก' } }) });
            await expect(getRealAddress(13.7, 100.5)).resolves.toBe('บางรัก');
        });

        it('falls back to "Thailand" when the lookup fails', async () => {
            global.fetch.mockRejectedValue(new Error('network down'));

            await expect(getRealAddress(13.7, 100.5)).resolves.toBe('Thailand');
            expect(errorSpy).toHaveBeenCalled();
        });
    });

    describe('getWeatherData()', () => {
        let errorSpy;

        beforeEach(() => {
            errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            global.fetch = jest.fn();
        });

        afterEach(() => {
            errorSpy.mockRestore();
            delete global.fetch;
        });

        it('returns null without calling out when coordinates are missing', async () => {
            await expect(getWeatherData(null, null)).resolves.toBeNull();
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('maps the Open-Meteo weather code to a description', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ current_weather: { temperature: 31.4, weathercode: 61 } }) });

            await expect(getWeatherData(13.7, 100.5)).resolves.toEqual({ temp: 31.4, description: 'Rainy' });
        });

        it('covers the documented code table', async () => {
            const expected = {
                0: 'Clear sky', 2: 'Partly cloudy', 45: 'Fog', 80: 'Rain showers', 95: 'Thunderstorm'
            };

            for (const [code, description] of Object.entries(expected)) {
                global.fetch.mockResolvedValue({ json: async () => ({ current_weather: { temperature: 30, weathercode: Number(code) } }) });
                // eslint-disable-next-line no-await-in-loop
                await expect(getWeatherData(13.7, 100.5)).resolves.toMatchObject({ description });
            }
        });

        it('labels an unknown code as "Varies"', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ current_weather: { temperature: 30, weathercode: 999 } }) });

            await expect(getWeatherData(13.7, 100.5)).resolves.toMatchObject({ description: 'Varies' });
        });

        it('tolerates a response with no current_weather block', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({}) });

            await expect(getWeatherData(13.7, 100.5)).resolves.toEqual({ temp: undefined, description: 'Varies' });
        });

        it('returns null when the lookup fails', async () => {
            global.fetch.mockRejectedValue(new Error('timeout'));

            await expect(getWeatherData(13.7, 100.5)).resolves.toBeNull();
            expect(errorSpy).toHaveBeenCalled();
        });
    });
});
