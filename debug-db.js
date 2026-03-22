// Debug script to check PostgREST connection
import fetch from 'node-fetch';

const DB_URL = process.env.DB_URL || 'http://localhost:3001';

async function test() {
    console.log(`Checking connection to: ${DB_URL}`);
    try {
        const res = await fetch(`${DB_URL}/clients?limit=1`);
        if (res.ok) {
            const data = await res.json();
            console.log('✅ PostgREST is UP.');
            console.log(`Found ${data.length} clients in registry.`);
        } else {
            console.log(`❌ PostgREST returned error: ${res.status} ${res.statusText}`);
        }
    } catch (e) {
        console.log(`❌ Failed to connect to PostgREST: ${e.message}`);
    }
}

test();
