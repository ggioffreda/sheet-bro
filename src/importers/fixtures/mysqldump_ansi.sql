-- mysqldump --compatible=ansi output (no backticks, ANSI quotes for identifiers)

DROP TABLE IF EXISTS "items";
CREATE TABLE "items" (
  "sku" varchar(32) NOT NULL,
  "name" varchar(255) NOT NULL,
  "price_cents" int(11) NOT NULL DEFAULT '0',
  "in_stock" tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY ("sku")
);

INSERT INTO "items" VALUES ('WIDGET-1','Widget',999,1),('GIZMO-2','Gizmo',2499,0),('SPROCKET-3','Sprocket ''12"',4999,1);
