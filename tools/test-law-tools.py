#!/usr/bin/env python3
"""Офлайн-проверка ручного сборщика: python3 tools/test-law-tools.py.

Требует beautifulsoup4 и lxml, как и сборщик. Синтетические тексты не являются
юридическими источниками. Рабочие src/data/ не изменяет.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class BuildRevisionsTest(unittest.TestCase):
    def test_history_and_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / 'cache'
            out = Path(tmp) / 'out'
            for doc, title, text in (
                ('pdd', '1. Общие положения', '1.5. Тестовое правило.'),
                ('koap', 'Статья 12.7. Тестовая статья', '1. Тестовый состав -'),
                ('uk', 'Статья 264. Тестовая статья', '1. Тестовый состав -'),
            ):
                for year in (2000, 2010):
                    directory = cache / doc / f'{year}-01-01'
                    directory.mkdir(parents=True)
                    metadata = {
                        'url': 'https://example.test/law', 'docTitle': 'Синтетический источник',
                        'revisionDate': f'{year}-01-01', 'validFrom': f'{year}-01-01',
                        **({'validTo': '2010-01-01'} if year == 2000 else {}),
                    }
                    (directory / 'snapshot.json').write_text(json.dumps(metadata))
                    (directory / 'index.json').write_text(json.dumps([{'hash': 'fixture', 'title': title, 'url': metadata['url']}]))
                    sanction = 'влечет предупреждение.' if doc == 'koap' else 'наказывается ограничением свободы.'
                    body = f'<p>{text} ({year})</p>' + (f'<p>{sanction}</p><p>2 - 3. Утратили силу.</p>' if doc != 'pdd' else '')
                    (directory / 'fixture.html').write_text(f'<div class="document-page__content">{body}</div>')
                    if doc == 'uk':
                        # Qualification requires these articles; fixtures carry explicitly synthetic metadata.
                        index = json.loads((directory / 'index.json').read_text())
                        for article in ('109', '118'):
                            name = f'fixture-{article}'
                            index.append({'hash': name, 'title': f'Статья {article}. Тестовая статья', 'url': metadata['url']})
                            (directory / f'{name}.html').write_text(f'<div class="document-page__content">{body}</div>')
                        (directory / 'index.json').write_text(json.dumps(index))
            cmd = [sys.executable, str(ROOT / 'tools/build-law.py'), str(cache), '--out', str(out)]
            built = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            pdd = json.loads((out / 'pdd.json').read_text())
            point = pdd['sections'][0]['points'][0]
            self.assertEqual([r['validFrom'] for r in point['revisions']], ['2000-01-01', '2010-01-01'])
            self.assertEqual(point['text'], point['revisions'][-1]['text'])
            for doc in ('koap', 'uk'):
                part = json.loads((out / f'{doc}.json').read_text())['articles'][0]['parts'][0]
                self.assertEqual(len(part['revisions']), 2)
                self.assertTrue(all(r['sanction'] in r['text'] for r in part['revisions']))
                self.assertNotIn('Утратили', part['text'])
                parts = json.loads((out / f'{doc}.json').read_text())['articles'][0]['parts']
                self.assertEqual([p['n'] for p in parts], ['1', '2', '3'])
            # Открытый старый интервал пересекается с новым: сборка должна отказать.
            path = cache / 'koap/2000-01-01/snapshot.json'
            metadata = json.loads(path.read_text())
            del metadata['validTo']
            path.write_text(json.dumps(metadata))
            failed = subprocess.run(cmd, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('Пересечение редакций', failed.stderr)


if __name__ == '__main__':
    unittest.main()
