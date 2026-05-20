-- migrate:up

-- Reverse-geocoding (BASIC tier): nearest GeoNames place from a lat/lng,
-- backing `geo_lookup()` for event geo enrichment (see
-- packages/server/src/utils/geo-enrichment.ts).
--
-- Built on core-contrib `cube` + `earthdistance` (great-circle distance over
-- 3D earth points) — NOT PostGIS. earthdistance ships in every standard
-- Postgres (embedded, RDS, Homebrew, …), so this works on every backend with
-- zero extra binaries. The accurate tiers (street address, venue/POI) are
-- filled in on-device by the apple.photos connector via Apple frameworks; see
-- the place_name note in packages/connectors/src/apple_photos.ts.
--
-- The schema was lost in the 2026-05-19 migration squash; this re-adds it
-- unconditionally (the tables are empty until seeded by scripts/seed-geo-data.sh,
-- and geo-enrichment self-disables while geo_places is empty).

CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE TABLE IF NOT EXISTS public.geo_countries (
  code text PRIMARY KEY,
  code3 text,
  name text NOT NULL,
  continent text
);

CREATE TABLE IF NOT EXISTS public.geo_admin1 (
  code text PRIMARY KEY,            -- "<country>.<admin1>" e.g. "IT.07"
  country_code text NOT NULL,
  name text NOT NULL,
  ascii_name text
);

CREATE TABLE IF NOT EXISTS public.geo_places (
  geonameid bigint PRIMARY KEY,
  name text NOT NULL,
  ascii_name text,
  alt_names text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  feature_class text,
  feature_code text,
  country_code text,
  admin1_code text,
  admin2_code text,
  population bigint,
  elevation_m integer,
  timezone text
);

-- GiST KNN index over the 3D earth point. ll_to_earth is IMMUTABLE, so it is
-- index-able; `<->` (cube distance) drives nearest-neighbour scans.
CREATE INDEX IF NOT EXISTS geo_places_earth_idx
  ON public.geo_places USING gist (ll_to_earth(latitude, longitude));

-- Nearest place to (lat,lng). KNN orders by chord distance (`<->`, index-backed);
-- chord distance is monotonic with great-circle, so the nearest by `<->` is the
-- nearest by earth_distance, which we report in km. Country/admin1 names are
-- joined from their reference tables.
CREATE OR REPLACE FUNCTION public.geo_lookup(in_lat double precision, in_lng double precision)
RETURNS TABLE (
  place_name text,
  place_id bigint,
  country_code text,
  country_name text,
  admin1_code text,
  admin1_name text,
  timezone text,
  population bigint,
  distance_km double precision
)
LANGUAGE sql STABLE AS $$
  SELECT
    p.name AS place_name,
    p.geonameid AS place_id,
    p.country_code,
    c.name AS country_name,
    p.admin1_code,
    a.name AS admin1_name,
    p.timezone,
    p.population,
    earth_distance(
      ll_to_earth(p.latitude, p.longitude),
      ll_to_earth(in_lat, in_lng)
    ) / 1000.0 AS distance_km
  FROM public.geo_places p
  LEFT JOIN public.geo_countries c ON c.code = p.country_code
  LEFT JOIN public.geo_admin1 a
    ON a.code = p.country_code || '.' || p.admin1_code
  ORDER BY ll_to_earth(p.latitude, p.longitude) <-> ll_to_earth(in_lat, in_lng)
  LIMIT 1
$$;

-- migrate:down

DROP FUNCTION IF EXISTS public.geo_lookup(double precision, double precision);
DROP TABLE IF EXISTS public.geo_places;
DROP TABLE IF EXISTS public.geo_admin1;
DROP TABLE IF EXISTS public.geo_countries;
