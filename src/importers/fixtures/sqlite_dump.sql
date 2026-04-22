PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO users VALUES(1,'alice@example.com','2026-01-01 00:00:00');
INSERT INTO users VALUES(2,'bob@example.com','2026-01-02 00:00:00');
INSERT INTO users VALUES(3,'carol@example.com','2026-01-03 00:00:00');
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER REFERENCES users(id),
  body TEXT
);
INSERT INTO posts VALUES(1,1,'hello world');
INSERT INTO posts VALUES(2,1,'it''s me');
INSERT INTO posts VALUES(3,2,'multi
line');
COMMIT;
