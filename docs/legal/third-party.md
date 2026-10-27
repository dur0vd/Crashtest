# Сторонние материалы и лицензии

> **ЧЕРНОВИК — требует проверки юристом.** Сводка составлена по `package-lock.json` и полям `license` в установленных пакетах. Перед публикацией проверьте состав и условия лицензий, особенно для изображений и нормативных текстов.

## 1. Изображения знаков и разметки

Изображения описаны в манифестах `public/signs/SOURCES.json` и `public/markings/SOURCES.json`: для каждого файла указан источник, лицензия и автор.

- **Знаки** — собственная упрощённая отрисовка владельца проекта по ГОСТ Р 52290-2004 (`tools/sign_art.py`); для части указателей направлений — форма, цвет и номер знака. Файлы с Wikimedia Commons с лицензией PD, CC0, CC BY или CC BY-SA можно подключить скриптом `tools/fetch-signs-commons.py`; они заносятся в манифест с атрибуцией. Изображения дорожных знаков, утверждённые как государственные стандарты, как правило, не охраняются авторским правом (п. 6 ст. 1259 ГК РФ), но конкретный рисунок третьего лица может охраняться — поэтому используются только собственные или свободно лицензированные файлы.
- **Разметка** — собственная отрисовка (`tools/build-markings.py`), упрощена для символов и пиктограмм.

## 2. Нормативные тексты

Тексты Правил дорожного движения, КоАП РФ и УК РФ — официальные документы и не являются объектами авторских прав (п. 6 ст. 1259 ГК РФ). В разборе нормы изложены кратко, своими словами, с идентификаторами; в справочнике приложение показывает полные тексты. Полные тексты корпуса выгружены с официального интернет-портала правовой информации (ИПС «Законодательство России», actual.pravo.gov.ru) без редакционных материалов справочно-правовых систем; номера и даты редакций — в поле `editions` файлов `src/data/*.json`, порядок обновления — в `docs/LEGAL.md`.

## 3. Зависимости npm

В собранное приложение попадает только собственный код: npm-пакеты в `src/` не импортируются. Пакеты ниже нужны для сборки, тестов и обёртки Capacitor (`devDependencies` и `dependencies`).

### Прямые зависимости

| Пакет | Версия | Лицензия |
| --- | --- | --- |
| @capacitor/android | 8.5.3 | MIT |
| @capacitor/cli | 8.5.3 | MIT |
| @capacitor/core | 8.5.3 | MIT |
| @capacitor/ios | 8.5.3 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 8.3.4 | MIT |
| vitest | 5.0.5 | MIT |

### Все пакеты lock-файла

| Пакет | Версия | Лицензия | Тип |
| --- | --- | --- | --- |
| @capacitor/android | 8.5.3 | MIT | prod |
| @capacitor/cli | 8.5.3 | MIT | dev |
| @capacitor/core | 8.5.3 | MIT | prod |
| @capacitor/ios | 8.5.3 | MIT | prod |
| @ionic/cli-framework-output | 2.2.8 | MIT | dev |
| @ionic/utils-array | 2.1.6 | MIT | dev |
| @ionic/utils-fs | 3.1.7 | MIT | dev |
| @ionic/utils-fs/node_modules/fs-extra | 9.1.0 | MIT | dev |
| @ionic/utils-object | 2.1.6 | MIT | dev |
| @ionic/utils-process | 2.1.12 | MIT | dev |
| @ionic/utils-stream | 3.1.7 | MIT | dev |
| @ionic/utils-subprocess | 3.0.1 | MIT | dev |
| @ionic/utils-terminal | 2.3.5 | MIT | dev |
| @isaacs/fs-minipass | 4.0.1 | ISC | dev |
| @jridgewell/resolve-uri | 3.1.2 | MIT | dev |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT | dev |
| @jridgewell/trace-mapping | 0.3.31 | MIT | dev |
| @oxc-project/types | 0.154.0 | MIT | dev |
| @rolldown/binding-linux-x64-gnu | 1.2.14 | MIT | dev |
| @rolldown/binding-linux-x64-musl | 1.2.14 | MIT | dev |
| @rolldown/pluginutils | 1.0.1 | MIT | dev |
| @types/chai | 5.2.3 | MIT | dev |
| @types/deep-eql | 4.0.2 | MIT | dev |
| @types/estree | 1.0.9 | MIT | dev |
| @types/fs-extra | 8.1.5 | MIT | dev |
| @types/node | 26.6.5 | MIT | dev |
| @types/slice-ansi | 4.0.0 | MIT | dev |
| @vitest/mocker | 5.0.5 | MIT | dev |
| @vitest/spy | 5.0.5 | MIT | dev |
| @xmldom/xmldom | 0.9.12 | MIT | dev |
| ansi-regex | 5.0.1 | MIT | dev |
| ansi-styles | 4.3.0 | MIT | dev |
| assertion-error | 2.0.1 | MIT | dev |
| astral-regex | 2.0.0 | MIT | dev |
| at-least-node | 1.0.0 | ISC | dev |
| balanced-match | 4.0.4 | MIT | dev |
| base64-js | 1.5.1 | MIT | dev |
| big-integer | 1.6.52 | Unlicense | dev |
| bplist-creator | 0.1.0 | MIT | dev |
| bplist-parser | 0.3.2 | MIT | dev |
| brace-expansion | 5.0.12 | MIT | dev |
| buffer-crc32 | 0.2.13 | MIT | dev |
| chai | 6.3.0 | MIT | dev |
| chownr | 3.0.0 | BlueOak-1.0.0 | dev |
| color-convert | 2.0.1 | MIT | dev |
| color-name | 1.1.4 | MIT | dev |
| commander | 12.1.0 | MIT | dev |
| cross-spawn | 7.0.6 | MIT | dev |
| debug | 4.4.3 | MIT | dev |
| define-lazy-prop | 2.0.0 | MIT | dev |
| detect-libc | 2.1.2 | Apache-2.0 | dev |
| elementtree | 0.1.7 | Apache-2.0 | dev |
| emoji-regex | 8.0.0 | MIT | dev |
| env-paths | 2.2.1 | MIT | dev |
| es-module-lexer | 2.3.2 | MIT | dev |
| estree-walker | 3.0.3 | MIT | dev |
| expect-type | 1.4.0 | Apache-2.0 | dev |
| fd-slicer | 1.1.0 | MIT | dev |
| fdir | 6.5.0 | MIT | dev |
| fs-extra | 11.4.1 | MIT | dev |
| glob | 13.0.6 | BlueOak-1.0.0 | dev |
| graceful-fs | 4.2.11 | ISC | dev |
| inherits | 2.0.4 | ISC | dev |
| ini | 4.1.3 | ISC | dev |
| is-docker | 2.2.1 | MIT | dev |
| is-fullwidth-code-point | 3.0.0 | MIT | dev |
| is-wsl | 2.2.0 | MIT | dev |
| isexe | 2.0.0 | ISC | dev |
| jsonfile | 6.2.1 | MIT | dev |
| kleur | 4.1.5 | MIT | dev |
| lightningcss | 1.33.0 | MPL-2.0 | dev |
| lightningcss-linux-x64-gnu | 1.33.0 | MPL-2.0 | dev |
| lightningcss-linux-x64-musl | 1.33.0 | MPL-2.0 | dev |
| lru-cache | 11.5.3 | BlueOak-1.0.0 | dev |
| magic-string | 1.4.3 | MIT | dev |
| minimatch | 10.2.6 | BlueOak-1.0.0 | dev |
| minipass | 7.1.3 | BlueOak-1.0.0 | dev |
| minizlib | 3.1.0 | MIT | dev |
| ms | 2.1.3 | MIT | dev |
| nanoid | 3.3.20 | MIT | dev |
| native-run | 2.0.3 | MIT | dev |
| obug | 3.0.0 | MIT | dev |
| open | 8.4.2 | MIT | dev |
| package-json-from-dist | 1.0.1 | BlueOak-1.0.0 | dev |
| path-key | 3.1.1 | MIT | dev |
| path-scurry | 2.0.2 | BlueOak-1.0.0 | dev |
| pend | 1.2.0 | MIT | dev |
| picocolors | 1.1.1 | ISC | dev |
| picomatch | 4.0.7 | MIT | dev |
| plist | 3.1.1 | MIT | dev |
| postcss | 8.5.31 | MIT | dev |
| prompts | 2.4.2 | MIT | dev |
| prompts/node_modules/kleur | 3.0.3 | MIT | dev |
| readable-stream | 3.6.2 | MIT | dev |
| rimraf | 6.1.3 | BlueOak-1.0.0 | dev |
| rolldown | 1.2.14 | MIT | dev |
| safe-buffer | 5.2.1 | MIT | dev |
| sax | 1.1.4 | ISC | dev |
| semver | 7.8.5 | ISC | dev |
| shebang-command | 2.0.0 | MIT | dev |
| shebang-regex | 3.0.0 | MIT | dev |
| signal-exit | 3.0.7 | ISC | dev |
| simple-plist | 1.3.1 | MIT | dev |
| simple-plist/node_modules/bplist-parser | 0.3.1 | MIT | dev |
| sisteransi | 1.0.5 | MIT | dev |
| slice-ansi | 4.0.0 | MIT | dev |
| source-map-js | 1.2.2 | BSD-3-Clause | dev |
| split2 | 4.2.0 | ISC | dev |
| std-env | 4.3.0 | MIT | dev |
| stream-buffers | 2.2.0 | Unlicense | dev |
| string-width | 4.2.3 | MIT | dev |
| string_decoder | 1.3.0 | MIT | dev |
| strip-ansi | 6.0.1 | MIT | dev |
| tar | 7.5.22 | BlueOak-1.0.0 | dev |
| through2 | 4.0.2 | MIT | dev |
| tinybench | 6.2.2 | MIT | dev |
| tinyexec | 1.3.1 | MIT | dev |
| tinyglobby | 0.2.17 | MIT | dev |
| tree-kill | 1.2.2 | MIT | dev |
| tslib | 2.8.1 | 0BSD | prod |
| typescript | 5.9.3 | Apache-2.0 | dev |
| undici-types | 8.9.0 | MIT | dev |
| universalify | 2.0.1 | MIT | dev |
| untildify | 4.0.0 | MIT | dev |
| util-deprecate | 1.0.2 | MIT | dev |
| uuid | 7.0.3 | MIT | dev |
| vite | 8.3.4 | MIT | dev |
| vitest | 5.0.5 | MIT | dev |
| which | 2.0.2 | ISC | dev |
| why-is-node-running | 3.2.1 | MIT | dev |
| wrap-ansi | 7.0.0 | MIT | dev |
| xcode | 3.0.1 | Apache-2.0 | dev |
| xml2js | 0.6.2 | MIT | dev |
| xml2js/node_modules/xmlbuilder | 11.0.1 | MIT | dev |
| xmlbuilder | 15.1.1 | MIT | dev |
| yallist | 5.0.0 | BlueOak-1.0.0 | dev |
| yauzl | 2.10.0 | MIT | dev |
