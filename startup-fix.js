// Hostinger startup guard.
// The latest MTProto session is persisted in the SQLite database.
// Ignore a legacy MT_SESSION environment variable so an old session
// cannot override the freshly authorized session stored in the DB.
if (process.env.MT_SESSION) {
  console.log("Ignoring legacy MT_SESSION environment variable; using persistent DB session.");
  delete process.env.MT_SESSION;
}
