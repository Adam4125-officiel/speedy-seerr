#!/usr/bin/env bash
# Synthetic request rows (fake data, real TMDB ids so titles resolve) to
# reproduce a populated home page locally. All in one connection so
# last_insert_rowid()/joins work.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$REPO/config/db/db.sqlite3"
sqlite3 "$DB" <<'SQL'
DELETE FROM media_request;
DELETE FROM media;
INSERT INTO media (mediaType,tmdbId,status,status4k) VALUES
 ('movie',550,3,1),('movie',680,3,1),('movie',13,3,1),('movie',155,3,1),
 ('movie',27205,3,1),('movie',157336,3,1),('movie',19995,3,1),('movie',24428,3,1),
 ('movie',299536,3,1),('movie',496243,3,1),('movie',278,3,1),('movie',238,3,1),
 ('tv',1399,3,1),('tv',1396,3,1),('tv',66732,3,1),('tv',60625,3,1),
 ('tv',1402,3,1),('tv',456,3,1),('tv',62286,3,1),('tv',71446,3,1);
INSERT INTO media_request (status,type,mediaId,requestedById,is4k)
 SELECT 2, mediaType, id, 1, 0 FROM media;
SQL
echo "media=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM media;') requests=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM media_request;') joined=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM media_request r JOIN media m ON m.id=r.mediaId;')"
