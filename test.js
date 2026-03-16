async function testBackend() {
  try {
    const res = await fetch('http://localhost:3000/api/stats');
    const data = await res.json();
    console.log('Backend Stats OK:', data);
    process.exit(0);
  } catch(e) {
    console.error('Backend test failure:', e);
    process.exit(1);
  }
}
setTimeout(testBackend, 2000);
