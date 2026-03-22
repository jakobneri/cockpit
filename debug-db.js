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
            
            // Check for RPC function (v2: with sample POST)
            console.log('Testing RPC call...');
            const rpcRes = await fetch(`${DB_URL}/rpc/report_client_metrics`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Prefer': 'params=single-object' },
                body: JSON.stringify({ hostname: 'debug_test', stats: {}, system_info: { model: 'Debug' } })
            });
            
            if (rpcRes.ok) {
                const result = await rpcRes.json();
                console.log('✅ RPC function is WORKING.', result);
            } else {
                console.log(`❌ RPC function CALL FAILED (Status: ${rpcRes.status} ${rpcRes.statusText})`);
                const errText = await rpcRes.text();
                console.log('Response body:', errText);
            }
        } else {
            console.log(`❌ PostgREST returned error: ${res.status} ${res.statusText}`);
        }
    } catch (e) {
        console.log(`❌ Failed to connect to PostgREST: ${e.message}`);
    }
}

test();
