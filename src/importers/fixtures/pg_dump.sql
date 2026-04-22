-- PostgreSQL pg_dump output. Intentionally unsupported; the normalizer
-- should fail loudly (either producing SQL that sql.js rejects, or failing
-- during normalization). This fixture exists so the test suite asserts the
-- failure surfaces rather than letting garbage data through silently.

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL
);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

COPY public.users (id, email) FROM stdin;
1	alice@example.com
2	bob@example.com
\.

CREATE FUNCTION public.f() RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN 1;
END;
$$;
