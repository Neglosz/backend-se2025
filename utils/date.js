// Shared date formatting helper for SQL-compatible dates.
const convertDateFormat = (dateInput) => {
    if (!dateInput) return null;
    try {
        let d;

        // Check if input is in DD/MM/YYYY format (from frontend)
        if (typeof dateInput === 'string' && dateInput.includes('/')) {
            const parts = dateInput.split('/');
            if (parts.length === 3) {
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
                const year = parseInt(parts[2], 10);
                d = new Date(year, month, day);
            } else {
                d = new Date(dateInput);
            }
        } else {
            d = new Date(dateInput);
        }

        if (isNaN(d.getTime())) return null; // Invalid date
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        console.error('Date conversion error', e);
        return null;
    }
};

module.exports = { convertDateFormat };
