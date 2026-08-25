const { convertDateFormat } = require('../../utils/date');

describe('utils/date convertDateFormat()', () => {
    it('returns null for falsy input', () => {
        expect(convertDateFormat(null)).toBeNull();
        expect(convertDateFormat(undefined)).toBeNull();
        expect(convertDateFormat('')).toBeNull();
        expect(convertDateFormat(0)).toBeNull();
    });

    it('converts DD/MM/YYYY (frontend format) to YYYY-MM-DD', () => {
        expect(convertDateFormat('25/12/2025')).toBe('2025-12-25');
        expect(convertDateFormat('01/01/2024')).toBe('2024-01-01');
    });

    it('zero-pads single-digit day and month', () => {
        expect(convertDateFormat('5/3/2025')).toBe('2025-03-05');
    });

    it('passes an already-ISO date through unchanged', () => {
        expect(convertDateFormat('2025-06-15')).toBe('2025-06-15');
    });

    it('reduces a full ISO timestamp to its local date part', () => {
        const input = new Date(2025, 5, 15, 13, 45).toISOString();
        expect(convertDateFormat(input)).toBe('2025-06-15');
    });

    it('accepts a Date object', () => {
        expect(convertDateFormat(new Date(2025, 0, 9))).toBe('2025-01-09');
    });

    it('returns null for an unparseable string', () => {
        expect(convertDateFormat('not-a-date')).toBeNull();
        expect(convertDateFormat('12/2025')).toBeNull();
    });

    it('rolls over out-of-range DD/MM parts the way the Date constructor does', () => {
        // Documented as current behaviour, not as intent: the helper hands the parts
        // straight to `new Date(y, m, d)` and does no calendar validation.
        expect(convertDateFormat('32/01/2025')).toBe('2025-02-01');
        expect(convertDateFormat('01/13/2025')).toBe('2026-01-01');
    });

    it('reads a slash-separated YYYY/MM/DD date in the right order', () => {
        // A 4-digit leading part identifies the year, so this is not mistaken for
        // DD/MM/YYYY (which used to produce 1920-12-15).
        expect(convertDateFormat('2025/06/15')).toBe('2025-06-15');
        expect(convertDateFormat('2024/1/9')).toBe('2024-01-09');
    });

    it('still reads DD/MM/YYYY when the year is last', () => {
        expect(convertDateFormat('15/06/2025')).toBe('2025-06-15');
        expect(convertDateFormat('9/1/2024')).toBe('2024-01-09');
    });

    it('always returns null or a YYYY-MM-DD string', () => {
        const inputs = ['25/12/2025', '2025-06-15', new Date(2025, 3, 4), 'garbage', null];
        for (const input of inputs) {
            const out = convertDateFormat(input);
            if (out !== null) expect(out).toMatch(/^\d{4,}-\d{2}-\d{2}$/);
        }
    });
});
