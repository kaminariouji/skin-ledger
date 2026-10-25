// Cross-platform launcher: "MOCK=1 node server.mjs" fails in cmd.exe and PowerShell.
process.env.MOCK = '1';
await import('./server.mjs');
