const { Client } = require('pg');

const users = ['apple', 'postgres', 'MSafi', 'M Safi', 'Administrator'];
const passwords = ['', 'apple', 'postgres', 'admin', 'root', 'password', '123456', '12345678', 'admin123', 'postgres123', 'password123', 'agncypay'];
const dbs = ['agncypay', 'postgres'];

async function test() {
  for (const user of users) {
    for (const pw of passwords) {
      for (const db of dbs) {
        let url = `postgresql://${user}`;
        if (pw) {
          url += `:${encodeURIComponent(pw)}`;
        }
        url += `@localhost:5432/${db}`;

        const client = new Client({ connectionString: url });
        try {
          await client.connect();
          console.log(`SUCCESS: Connected to ${url}`);
          await client.end();
          return;
        } catch (e) {
          // ignore auth failures, print if it's something else
          if (!e.message.includes('authentication failed')) {
            console.log(`OTHER ERROR: ${url} - ${e.message}`);
          }
        }
      }
    }
  }
  console.log("All combinations failed.");
}

test();
