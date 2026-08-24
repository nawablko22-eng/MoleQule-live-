// One-off helper: `npm run generate-vapid`
// Prints a fresh VAPID key pair to paste into your .env file.
const webpush = require("web-push");
const keys = webpush.generateVAPIDKeys();
console.log("Add these to your .env:\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
