# Publicación segura

## Regla de salida

No se publica ni se sube un paquete a Chrome Web Store sin que el workflow **Quality Gate** de GitHub esté en verde para el commit exacto que se va a publicar.

## Extensión

1. Verificar que `Extension` aprueba sintaxis, pruebas y generación del ZIP.
2. Descargar el artefacto `lyn-superagente-extension` generado por GitHub Actions; no reutilizar un ZIP local anterior.
3. Confirmar que la versión de `extension/manifest.json` aumenta respecto a la última versión publicada.
4. En Chrome Web Store, subir ese ZIP como actualización y enviar a revisión.
5. Tras aprobación, comprobar en Chrome que el icono abre el panel, que la activación funciona y que un resumen de prueba no genera errores.

## Backend y dashboard

1. Verificar que los trabajos `Backend` y `Dashboard` están en verde.
2. Desplegar únicamente el commit validado con el script de producción.
3. Comprobar `/health`, inicio de sesión CEO y una cuenta de extensión de prueba.

## Protección de `main`

En GitHub, crear una regla de protección para `main` que exija los checks `Backend`, `Dashboard` y `Extension` antes de permitir un merge. Así el Quality Gate deja de ser solo informativo y bloquea cambios no validados.