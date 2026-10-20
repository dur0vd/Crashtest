#!/usr/bin/env python3
"""Extract a compact, dated sanctions index from the checked-in legal corpus.

Run after updating koap.json / uk.json; never supplies historical editions.
"""
import json
import re
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / 'src' / 'data'
entries = {}
for code in ('koap', 'uk'):
    corpus = json.loads((DATA / f'{code}.json').read_text(encoding='utf-8'))
    for article in corpus['articles']:
        for part in article['parts']:
            match = re.search(r'(?:^|\n|\s)(?:-|—)?\s*\n?((?:влечет|наказывается)[\s\S]*)$', part['text'])
            # Use # to distinguish article numbers containing dots from part numbers.
            ref = f"{code}:{article['id']}#{part['n']}"
            entries[ref] = {
                'editionDate': corpus['fetched'],
                'text': match[1].replace('\n', ' ').strip() if match else None,
            }
(DATA / 'sanctions.json').write_text(
    json.dumps(entries, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
