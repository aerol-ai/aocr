# aocr registry

This directory contains the Docker Distribution registry image configuration used by **aocr**. The registry emits push notifications to the hooks service, which records repository/tag metadata in PostgreSQL. Cleanup of older images is handled by the reaper process, which keeps only the latest image per repository.
