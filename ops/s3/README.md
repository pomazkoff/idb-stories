# Права S3 по сервисам (образцы IAM-политик для хранилища ИДБ)

Каждому процессу — свои ключи и минимальные права (раздел 10.5, T11). Имена бакетов — по умолчанию.

| Процесс | quarantine | media | public |
|---|---|---|---|
| API (admin) | PutObject — только для подписи presigned PUT; HeadObject | GetObject — подписанные превью | PutObject — копирование при публикации |
| jobs | — | GetObject (источник копирования) | PutObject — публикация по расписанию |
| media-worker | GetObject, HeadObject | PutObject | — |
| CDN | — | — | GetObject (origin) |

Удаление оригиналов из `quarantine` — lifecycle-правилом бакета (7 дней), ни у одного процесса нет DeleteObject.
