// Debug script to check PostgREST connection

const DB_URL = process.env.DB_URL || 'http://localhost:3001';

async function test() {
    console.log(`Checking connection to: ${DB_URL}`);
    try {
        const res = await fetch(`${DB_URL}/clients?select=hostname`);
        if (res.ok) {
            const data = await res.json();
            console.log('✅ PostgREST is UP.');
            console.log(`Found ${data.length} clients in registry.`);
            
            // Check for RPC function
            const rpcRes = await fetch(`${DB_URL}/rpc/report_client_metrics`, { method: 'OPTIONS' });
            if (rpcRes.ok) {
                console.log('✅ RPC function report_client_metrics is VISIBLE to PostgREST.');
            } else {
                console.log(`❌ RPC function NOT FOUND or NOT ACCESSIBLE (Status: ${rpcRes.status})`);
            }
        } else {
            console.log(`❌ PostgREST returned error: ${res.status} ${res.statusText}`);
        }
    } catch (e) {
        console.log(`❌ Failed to connect to PostgREST: ${e.message}`);
    }
}

test();
