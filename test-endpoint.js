const http = require('http');

const data = JSON.stringify({
    trans_date: "2023-10-27",
    trans_type: "expense",
    category: "Test",
    description: "Test endpoint",
    amount: 100,
    payment_method: "cash"
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'x-store-id': 'test-store-id' // Mock ID, middleware might block but status shouldn't be 404
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
        console.log(`BODY: ${chunk}`);
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

// Write data to request body
req.write(data);
req.end();
