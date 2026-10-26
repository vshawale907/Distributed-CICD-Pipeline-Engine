require('dotenv').config();
const { Pool } = require('pg');

const email = process.argv[2];
if (!email) {
  console.error('❌ Usage: node scripts/make-admin.js <email>');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function makeAdmin() {
  const result = await pool.query(
    `UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id, email, role`,
    [email]
  );

  if (result.rows.length === 0) {
    console.error(`❌ No user found with email: ${email}`);
  } else {
    console.log(`✅ Updated! User is now:`, result.rows[0]);
  }

  await pool.end();
}

makeAdmin().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
