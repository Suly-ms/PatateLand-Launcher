# Serveur de fichiers PatateLand (PHP + Apache), pour Coolify ou tout hôte Docker.
# Voir README.md : routes, stockage persistant, déploiement.
FROM php:8.3-apache

ENV PL_DATA_DIR=/var/www/data \
    PL_FILES_DIR=/var/www/files \
    PL_CACHE_DIR=/var/www/cache

COPY apache.conf /etc/apache2/sites-available/000-default.conf
RUN echo 'ServerName localhost' > /etc/apache2/conf-available/servername.conf \
 && a2enconf servername \
 && a2enmod deflate \
 && mkdir -p /var/www/files /var/www/cache \
 && chown www-data:www-data /var/www/cache \
 && rm -rf /var/www/html

COPY public/ /var/www/public/
# Données de départ : remplacées par le stockage persistant en production.
COPY data/ /var/www/data/

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1/ > /dev/null || exit 1
