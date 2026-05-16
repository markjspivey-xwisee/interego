"""
foxxi_storyline_parser_v03.py

v0.3 additions over v0.2:
  - Concept morphology: head-word extraction, modifier-of relations
  - Free-standing flag: bare topic words tagged fxk:isFreeStanding=false rather
    than dropped, preserving information for retrieval while keeping displays clean
  - Semiotic role assignment: heuristic Sign/Object/Interpretant tagging based
    on co-occurrence with definitional vs. applicative discourse markers
  - Prerequisite inference now honors free-standing flag — only edges between
    two free-standing concepts contribute to the visible topology
  - Aligned with vocab v0.2: no inline class declarations in PREAMBLE
  - Emits SHACL-clean RDF that validates against vocab v0.2's tighter shapes

v0.2 features retained: Whisper narration transcription, tiered confidence,
bag-of-words deduplication of n-gram permutations.
"""

import re
import json
from pathlib import Path
from urllib.parse import quote
from datetime import datetime, timezone
from collections import Counter, defaultdict

import sys
sys.path.insert(0, str(Path(__file__).parent))
from foxxi_storyline_parser import (
    parse_manifest,
    detect_authoring_tool,
    extract_storyline_content,
    _esc, _iri,
)
from foxxi_storyline_parser_v02 import (
    transcribe_audio,
    load_existing_transcripts,
    COURSE_STOPWORDS,
    extract_concept_candidates,
    consolidate_concepts,
    slugify,
    _bag_key,
)


# ----------------------------------------------------------------------
# Morphology — head word, modifier relations, free-standing detection
# ----------------------------------------------------------------------

def head_word(phrase):
    """
    Return the morphological head of an English noun phrase using the
    right-headed convention: the rightmost non-stopword content token.
    """
    tokens = phrase.split()
    for t in reversed(tokens):
        if t not in COURSE_STOPWORDS and len(t) >= 3:
            return t
    return tokens[-1] if tokens else phrase


def _bare_topic_words():
    """
    Single-word generic technical heads that typically need a modifier
    to denote a specific entity. Domain-aware but conservative.
    """
    return {
        'voltage', 'current', 'power', 'system', 'grid', 'control',
        'response', 'output', 'input', 'reference', 'signal', 'loop',
        'frequency', 'phase', 'mode', 'level', 'value', 'state',
        'time', 'point', 'rate', 'ratio', 'factor', 'flow',
        'function', 'method', 'approach', 'technique',
    }


def is_free_standing(phrase):
    """
    True if the phrase is likely a free-standing semiotic unit (multi-word
    technical phrase, or single word that isn't a generic topic head).
    """
    tokens = [t for t in phrase.split() if t not in COURSE_STOPWORDS]
    if len(tokens) >= 2:
        return True
    if len(tokens) == 1:
        return tokens[0] not in _bare_topic_words()
    return False


def find_modifier_relations(phrases):
    """
    Build (modifier, target) pairs where modifier and target share a head
    word and modifier has additional left-side modifiers.
    """
    by_head = defaultdict(list)
    for p in phrases:
        by_head[head_word(p)].append(p)
    
    relations = []
    for head, group in by_head.items():
        if len(group) < 2:
            continue
        sorted_by_len = sorted(group, key=lambda p: len(p.split()))
        for i, modifier in enumerate(sorted_by_len):
            best_target = None
            for j in range(i):
                target = sorted_by_len[j]
                if modifier.endswith(' ' + target) or (target == head and modifier.endswith(' ' + head)):
                    best_target = target
            if best_target:
                relations.append((modifier, best_target))
    return relations


# ----------------------------------------------------------------------
# Semiotic role assignment (heuristic)
# ----------------------------------------------------------------------

_OBJECT_MARKERS = [
    r'\bis the\b', r'\brefers to\b', r'\bis defined as\b',
    r'\bmeans\b', r'\bis a\b', r'\bare a\b',
    r'\bdescribes\b', r'\brepresents\b',
]
_INTERPRETANT_MARKERS = [
    r'\bbecause\b', r'\bwhen\b', r'\bso that\b', r'\bthus\b',
    r'\btherefore\b', r'\bin order to\b', r'\bto control\b',
    r'\bto produce\b', r'\bto manage\b',
]


def assign_semiotic_role(phrase, slide_corpora):
    """
    Heuristic role assignment based on discourse markers in surrounding
    context. A real OLKE pipeline would do much richer analysis.
    """
    object_score = 0
    interpretant_score = 0
    
    for sid, text in slide_corpora.items():
        lower = text.lower()
        if phrase.lower() not in lower:
            continue
        i = 0
        while True:
            idx = lower.find(phrase.lower(), i)
            if idx == -1: break
            ctx = lower[max(0, idx - 80): idx + len(phrase) + 80]
            for pat in _OBJECT_MARKERS:
                if re.search(pat, ctx):
                    object_score += 1
            for pat in _INTERPRETANT_MARKERS:
                if re.search(pat, ctx):
                    interpretant_score += 1
            i = idx + len(phrase)
    
    sign_score = max(0, object_score - interpretant_score - 1)
    if interpretant_score > object_score and interpretant_score > sign_score:
        return 'fxk:InterpretantRole'
    if sign_score > object_score:
        return 'fxk:SignRole'
    return 'fxk:ObjectRole'


# ----------------------------------------------------------------------
# v0.3 concept extraction
# ----------------------------------------------------------------------

def extract_concepts_per_slide_v03(slide_corpora, slide_order):
    slide_to_candidates = {}
    all_candidates = Counter()
    
    for sid, text in slide_corpora.items():
        scored = extract_concept_candidates(text, min_freq=1)
        top = consolidate_concepts(scored, top_k=20)
        slide_to_candidates[sid] = top
        for phrase, count, _ in top:
            all_candidates[phrase] += count
    
    bag_to_phrases = defaultdict(list)
    for phrase, total in all_candidates.items():
        bag_to_phrases[_bag_key(phrase)].append((phrase, total))
    canonical = {}
    for bag, phrases in bag_to_phrases.items():
        phrases.sort(key=lambda x: (-x[1], x[0]))
        for p, _ in phrases:
            canonical[p] = phrases[0][0]
    
    new_all = Counter()
    for phrase, count in all_candidates.items():
        new_all[canonical[phrase]] += count
    all_candidates = new_all
    
    new_slide = {}
    for sid, top in slide_to_candidates.items():
        seen = set()
        new_top = []
        for phrase, count, score in top:
            cp = canonical[phrase]
            if cp in seen: continue
            seen.add(cp)
            new_top.append((cp, count, score))
        new_slide[sid] = new_top
    slide_to_candidates = new_slide
    
    keep = set()
    tier_by_phrase = {}
    for phrase, total in all_candidates.items():
        in_slides = sum(1 for sc in slide_to_candidates.values()
                        if any(p == phrase for p, _, _ in sc))
        n_words = len(phrase.split())
        if in_slides >= 2:
            keep.add(phrase); tier_by_phrase[phrase] = 1
        elif in_slides == 1 and total >= 2 and n_words >= 2:
            keep.add(phrase); tier_by_phrase[phrase] = 2
        elif in_slides == 1 and n_words >= 2 and total >= 1:
            keep.add(phrase); tier_by_phrase[phrase] = 3
    
    concepts = {}
    slide_concepts = {sid: [] for sid in slide_corpora}
    for phrase in keep:
        concepts[phrase] = {
            'slide_ids': [],
            'total_freq': all_candidates[phrase],
            'confidence': 0.0,
            'tier': tier_by_phrase[phrase],
            'head_word': head_word(phrase),
            'is_free_standing': is_free_standing(phrase),
            'semiotic_role': None,
        }
    for sid, top in slide_to_candidates.items():
        for phrase, count, _ in top:
            if phrase in keep:
                concepts[phrase]['slide_ids'].append(sid)
                slide_concepts[sid].append(phrase)
    
    tier_base = {1: 0.85, 2: 0.65, 3: 0.45}
    for phrase, info in concepts.items():
        coverage = len(info['slide_ids']) / max(1, len(slide_corpora))
        freq_factor = min(1.0, info['total_freq'] / 5.0)
        base = tier_base[info['tier']]
        bonus = coverage * 0.05 + freq_factor * 0.05
        if info['is_free_standing']:
            bonus += 0.03
        info['confidence'] = round(min(0.95, base + bonus), 2)
    
    for phrase, info in concepts.items():
        info['semiotic_role'] = assign_semiotic_role(phrase, slide_corpora)
    
    modifier_pairs = find_modifier_relations(list(concepts.keys()))
    return concepts, slide_concepts, modifier_pairs


def infer_prerequisites_v03(slide_concepts, slide_order, concepts):
    """
    Same first-mention precedence rule as v0.2, but only emits edges where
    both endpoints are free-standing.
    """
    first_seen = {}
    for idx, sid in enumerate(slide_order):
        for c in slide_concepts.get(sid, []):
            if c not in first_seen:
                first_seen[c] = idx
    
    fs = {c: info['is_free_standing'] for c, info in concepts.items()}
    
    co_later = defaultdict(int)
    for idx, sid in enumerate(slide_order):
        cs = slide_concepts.get(sid, [])
        for a in cs:
            for b in cs:
                if a == b: continue
                if not (fs.get(a, True) and fs.get(b, True)):
                    continue
                if first_seen.get(a, 999) < first_seen.get(b, -1) <= idx:
                    if first_seen[a] < first_seen[b]:
                        co_later[(a, b)] += 1
    
    edges = []
    for (a, b), count in co_later.items():
        if count >= 1 and first_seen[a] < first_seen[b]:
            edges.append((a, b, count))
    max_count = max((c for _, _, c in edges), default=1)
    return [(a, b, round(0.4 + 0.5 * (c / max_count), 2)) for a, b, c in edges]


# ----------------------------------------------------------------------
# Turtle emission v0.3
# ----------------------------------------------------------------------

PREAMBLE_V3 = '''@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix schema:  <http://schema.org/> .
@prefix skos:    <http://www.w3.org/2004/02/skos/core#> .
@prefix cnt:     <http://www.w3.org/2011/content#> .
@prefix fxs:     <https://vocab.foxximediums.com/scorm#> .
@prefix fxk:     <https://vocab.foxximediums.com/knowledge#> .

# Consumes vocab v0.2. fxs:Slide, fxs:Scene, fxs:NarrationTranscript,
# fxk:semioticRole, fxk:headWord, fxk:isFreeStanding, fxk:modifierOf are
# all defined in https://vocab.foxximediums.com/scorm/0.2.0 and
# https://vocab.foxximediums.com/knowledge/0.2.0.

'''


def emit_turtle_v3(manifest, content, transcripts, concepts, slide_concepts,
                    prereq_edges, modifier_pairs, slide_id_to_audio_urls,
                    pkg_iri_base, parser_iri, extracted_at):
    lines = [PREAMBLE_V3]
    pkg_iri = f'<{pkg_iri_base}>'
    
    lines.append('# ═══════════════════════════════════════════════════')
    lines.append('# STRUCTURAL STRATUM (fxs:)')
    lines.append('# ═══════════════════════════════════════════════════')
    lines.append('')
    lines.append(f'{pkg_iri} a fxs:Package ;')
    lines.append(f'    dcterms:title "{_esc(manifest["organizations"][0]["title"])}" ;')
    lines.append(f'    dcterms:identifier "{manifest["package_id"]}" ;')
    lines.append(f'    fxs:identifiedBy "{manifest["package_id"]}" ;')
    lines.append(f'    fxs:standardConformance fxs:{manifest["standard"]} ;')
    if content and content.get('authoring_version'):
        lines.append(f'    schema:softwareVersion "{content["authoring_version"]}" ;')
    lines.append(f'    fxs:authoredWith fxs:ArticulateStoryline ;')
    org_iris = []
    for org in manifest['organizations']:
        org_iri = _iri(pkg_iri_base, 'org', org['id'])
        org_iris.append((org_iri, org['is_default']))
        lines.append(f'    fxs:hasOrganization {org_iri} ;')
    for oi, dflt in org_iris:
        if dflt:
            lines.append(f'    fxs:defaultOrganization {oi} ;')
            break
    lines.append(f'    prov:wasGeneratedBy <{parser_iri}> ;')
    lines.append(f'    prov:generatedAtTime "{extracted_at}"^^xsd:dateTime .')
    lines.append('')
    
    for org in manifest['organizations']:
        org_iri = _iri(pkg_iri_base, 'org', org['id'])
        lines.append(f'{org_iri} a fxs:Organization ;')
        lines.append(f'    dcterms:title "{_esc(org["title"])}" ;')
        lines.append(f'    fxs:identifiedBy "{org["id"]}" ;')
        item_iris = [_iri(pkg_iri_base, 'item', it['id']) for it in org['items']]
        if item_iris:
            lines.append(f'    fxs:hasItem {", ".join(item_iris)} .')
        lines.append('')
    
    def emit_item(item, depth=0, sequence_index=0):
        item_iri = _iri(pkg_iri_base, 'item', item['id'])
        lines.append(f'{item_iri} a fxs:Item ;')
        lines.append(f'    dcterms:title "{_esc(item["title"])}" ;')
        lines.append(f'    fxs:identifiedBy "{item["id"]}" ;')
        lines.append(f'    fxs:sequenceIndex {sequence_index} ;')
        if item['children']:
            cis = [_iri(pkg_iri_base, 'item', c['id']) for c in item['children']]
            lines.append(f'    fxs:hasChild {", ".join(cis)} ;')
        if item.get('identifierref') and item['identifierref'] in manifest['resources']:
            res_iri = _iri(pkg_iri_base, 'res', item['identifierref'])
            lines.append(f'    fxs:hasResource {res_iri} ;')
        lines[-1] = lines[-1].rstrip(' ;') + ' .'
        lines.append('')
        for i, c in enumerate(item['children']):
            emit_item(c, depth + 1, i)
    for org in manifest['organizations']:
        for i, item in enumerate(org['items']):
            emit_item(item, 0, i)
    
    for res_id, res in manifest['resources'].items():
        res_iri = _iri(pkg_iri_base, 'res', res_id)
        cls = 'fxs:SCO' if res.get('scorm_type') == 'sco' else 'fxs:Asset'
        lines.append(f'{res_iri} a {cls} ;')
        lines.append(f'    fxs:identifiedBy "{res_id}" ;')
        if res.get('href'):
            lines.append(f'    fxs:fileLocator "package!/{res["href"]}" ;')
        lines.append(f'    prov:wasDerivedFrom {pkg_iri} .')
        lines.append('')
    
    if not content or not content.get('scenes'):
        return '\n'.join(lines)
    
    sco_res = next((r for r in manifest['resources'].values()
                    if r.get('scorm_type') == 'sco'), None)
    sco_iri = _iri(pkg_iri_base, 'res', sco_res['id']) if sco_res else pkg_iri
    
    lines.append('# ─── Storyline scenes & slides ───')
    lines.append('')
    
    slide_iri_by_id = {}
    for scene_idx, scene in enumerate(content['scenes']):
        scene_iri = _iri(pkg_iri_base, 'scene', scene['id'])
        lines.append(f'{scene_iri} a fxs:Scene ;')
        lines.append(f'    dcterms:title "Scene {scene["scene_number"]}" ;')
        lines.append(f'    fxs:identifiedBy "{scene["id"]}" ;')
        lines.append(f'    fxs:sequenceIndex {scene_idx} ;')
        slide_iris = [_iri(pkg_iri_base, 'slide', s['id']) for s in scene['slides']]
        if slide_iris:
            lines.append(f'    fxs:hasChild {", ".join(slide_iris)} ;')
        lines[-1] = lines[-1].rstrip(' ;') + ' .'
        lines.append('')
        
        for slide_idx, slide in enumerate(scene['slides']):
            slide_iri = _iri(pkg_iri_base, 'slide', slide['id'])
            slide_iri_by_id[slide['id']] = slide_iri
            lines.append(f'{slide_iri} a fxs:Slide ;')
            lines.append(f'    dcterms:title "{_esc(slide["title"])}" ;')
            lines.append(f'    fxs:identifiedBy "{slide["id"]}" ;')
            lines.append(f'    fxs:sequenceIndex {slide_idx} ;')
            lines.append(f'    fxs:fileLocator "package!/html5/data/js/{slide["id"]}.js" ;')
            lines.append(f'    prov:wasDerivedFrom {sco_iri} ;')
            if slide.get('lms_id'):
                lines.append(f'    schema:identifier "{slide["lms_id"]}" ;')
            for au in slide['audio_urls']:
                asset_iri = _iri(pkg_iri_base, 'asset', au)
                lines.append(f'    fxs:embedsAsset {asset_iri} ;')
            for au in slide['audio_urls']:
                if au in transcripts:
                    nar_iri = _iri(pkg_iri_base, 'narration', au)
                    lines.append(f'    fxs:hasNarration {nar_iri} ;')
            if slide['alt_text_corpus']:
                clean = '; '.join(set(t for t in slide['alt_text_corpus']
                                       if t and t != 'Image 41.emf'))[:1000]
                if clean:
                    lines.append(f'    fxs:extractedTextCorpus "{_esc(clean)}" ;')
            if lines[-1].endswith(' ;'):
                lines[-1] = lines[-1][:-2] + ' .'
            else:
                lines.append('    .')
            lines.append('')
            
            for au in slide['audio_urls']:
                asset_iri = _iri(pkg_iri_base, 'asset', au)
                lines.append(f'{asset_iri} a fxs:Asset ;')
                lines.append(f'    dcterms:format "audio/mpeg" ;')
                lines.append(f'    fxs:fileLocator "package!/{au}" ;')
                if au in transcripts:
                    duration = transcripts[au]['duration']
                    lines.append(f'    schema:duration "PT{int(duration)}S"^^xsd:duration ;')
                lines.append(f'    prov:wasDerivedFrom {pkg_iri} .')
                lines.append('')
                
                if au in transcripts:
                    nar_iri = _iri(pkg_iri_base, 'narration', au)
                    text = transcripts[au]['text']
                    lines.append(f'{nar_iri} a fxs:NarrationTranscript ;')
                    lines.append(f'    dcterms:language "{transcripts[au]["language"]}" ;')
                    lines.append(f'    schema:duration "PT{int(transcripts[au]["duration"])}S"^^xsd:duration ;')
                    lines.append(f'    cnt:chars "{_esc(text)}" ;')
                    lines.append(f'    fxs:transcribedBy <https://github.com/SYSTRAN/faster-whisper#tiny.en> ;')
                    lines.append(f'    prov:wasDerivedFrom {asset_iri} .')
                    lines.append('')
    
    lines.append('# ═══════════════════════════════════════════════════')
    lines.append('# SEMANTIC STRATUM (fxk:)')
    lines.append('# ═══════════════════════════════════════════════════')
    lines.append('')
    
    concept_iri_by_phrase = {}
    for phrase, info in concepts.items():
        cid = slugify(phrase)
        if not cid: continue
        concept_iri = _iri(pkg_iri_base, 'concept', cid)
        concept_iri_by_phrase[phrase] = concept_iri
        
        lines.append(f'{concept_iri} a fxk:Concept ;')
        lines.append(f'    skos:prefLabel "{_esc(phrase)}" ;')
        lines.append(f'    fxk:extractionConfidence {info["confidence"]} ;')
        lines.append(f'    fxk:headWord "{_esc(info["head_word"])}" ;')
        lines.append(f'    fxk:isFreeStanding {str(info["is_free_standing"]).lower()} ;')
        # NOTE: fxk:semioticRole was emitted in earlier v0.3 builds via a
        # discourse-marker heuristic in `assign_semiotic_role`. The heuristic
        # is unreliable (e.g. mistagged 'inverter' as InterpretantRole), so
        # we no longer emit it. Reintroduce in v0.4 with proper LLM/OLKE
        # backing.
        for sid in info['slide_ids'][:5]:
            if sid in slide_iri_by_id:
                lines.append(f'    fxk:taughtIn {slide_iri_by_id[sid]} ;')
        for sid in info['slide_ids'][:3]:
            if sid in slide_iri_by_id:
                lines.append(f'    prov:wasDerivedFrom {slide_iri_by_id[sid]} ;')
        lines.append(f'    prov:wasGeneratedBy <{parser_iri}#concept-extractor> .')
        lines.append('')
    
    if modifier_pairs:
        lines.append('# ─── Modifier-of (morphological head-modifier relations) ───')
        lines.append('')
        seen = set()
        for modifier, target in modifier_pairs:
            if (modifier, target) in seen: continue
            seen.add((modifier, target))
            if modifier in concept_iri_by_phrase and target in concept_iri_by_phrase:
                lines.append(f'{concept_iri_by_phrase[modifier]} fxk:modifierOf {concept_iri_by_phrase[target]} .')
        lines.append('')
    
    if prereq_edges:
        lines.append('# ─── Prerequisite (free-standing concepts only) ───')
        lines.append('')
        for a, b, conf in prereq_edges:
            if a not in concept_iri_by_phrase or b not in concept_iri_by_phrase:
                continue
            lines.append(f'{concept_iri_by_phrase[a]} fxk:prerequisiteOf {concept_iri_by_phrase[b]} .')
        lines.append('')
    
    lines.append('# ─── Parser provenance ───')
    lines.append(f'<{parser_iri}> a prov:SoftwareAgent ;')
    lines.append(f'    rdfs:label "foxxi-storyline-parser" ;')
    lines.append(f'    schema:softwareVersion "0.3.0" .')
    lines.append('')
    lines.append(f'<{parser_iri}#concept-extractor> a prov:SoftwareAgent ;')
    lines.append(f'    rdfs:label "foxxi heuristic concept extractor v0.3" ;')
    lines.append(f'    rdfs:comment "n-gram TF + bag-dedup + head-word morphology + free-standing tagging + heuristic semiotic role assignment. v0.4 will use LLM-backed OLKE decomposition." .')
    lines.append('')
    
    return '\n'.join(lines)


def parse_package_v3(pkg_dir, transcripts_path=None, run_whisper=True,
                     pkg_iri_base=None, parser_iri=None):
    pkg_dir = Path(pkg_dir)
    manifest = parse_manifest(pkg_dir / 'imsmanifest.xml')
    tool, version = detect_authoring_tool(pkg_dir)
    print(f"Authoring tool: {tool}  (version: {version})")
    
    content = None
    if tool == 'fxs:ArticulateStoryline':
        content = extract_storyline_content(pkg_dir)
    
    audio_relpaths = set()
    for scene in (content or {}).get('scenes', []):
        for slide in scene['slides']:
            for au in slide['audio_urls']:
                audio_relpaths.add(au)
    
    transcripts = {}
    if transcripts_path and Path(transcripts_path).exists():
        transcripts = json.loads(Path(transcripts_path).read_text())
        print(f"Loaded {len(transcripts)} cached transcripts")
    elif run_whisper:
        print(f"Transcribing {len(audio_relpaths)} audio files with whisper...")
        transcripts = transcribe_audio(pkg_dir, audio_relpaths)
        if transcripts_path:
            Path(transcripts_path).write_text(json.dumps(transcripts, indent=2))
    
    slide_corpora = {}
    slide_order = []
    slide_id_to_audio_urls = {}
    for scene in (content or {}).get('scenes', []):
        for slide in scene['slides']:
            sid = slide['id']
            slide_order.append(sid)
            slide_id_to_audio_urls[sid] = slide['audio_urls']
            parts = [slide['title']]
            for au in slide['audio_urls']:
                if au in transcripts:
                    parts.append(transcripts[au]['text'])
            slide_corpora[sid] = ' '.join(parts)
    
    print(f"Extracting concepts (v0.3 morphology + free-standing detection)...")
    concepts, slide_concepts, modifier_pairs = extract_concepts_per_slide_v03(
        slide_corpora, slide_order
    )
    fs = sum(1 for c in concepts.values() if c['is_free_standing'])
    print(f"  -> {len(concepts)} concepts ({fs} free-standing, {len(concepts)-fs} bare)")
    print(f"  -> {len(modifier_pairs)} modifier-of relations")
    
    prereq_edges = infer_prerequisites_v03(slide_concepts, slide_order, concepts)
    print(f"  -> {len(prereq_edges)} prerequisite edges (free-standing only)")
    
    pkg_iri_base = pkg_iri_base or f'https://example.foxximediums.com/pkg/{manifest["package_id"]}'
    parser_iri = parser_iri or 'https://vocab.foxximediums.com/parsers/storyline/0.3.0'
    extracted_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    
    turtle = emit_turtle_v3(
        manifest, content, transcripts, concepts, slide_concepts,
        prereq_edges, modifier_pairs, slide_id_to_audio_urls,
        pkg_iri_base, parser_iri, extracted_at
    )
    
    stats = {
        'manifest_items': sum(len(o['items']) for o in manifest['organizations']),
        'manifest_resources': len(manifest['resources']),
        'scenes': len((content or {}).get('scenes', [])),
        'slides': len(slide_order),
        'audio_files': len(audio_relpaths),
        'transcripts': len(transcripts),
        'audio_seconds': sum(t['duration'] for t in transcripts.values()),
        'concepts_total': len(concepts),
        'concepts_free_standing': fs,
        'modifier_pairs': len(modifier_pairs),
        'prereq_edges': len(prereq_edges),
    }
    return turtle, stats, manifest, content, concepts, slide_concepts, prereq_edges, modifier_pairs, transcripts


if __name__ == '__main__':
    pkg_dir = '/home/claude/storyline-test'
    out_path = '/home/claude/storyline-test/lesson3_v03.ttl'
    transcripts_path = '/home/claude/storyline-test/transcripts.json'
    
    turtle, stats, *_ = parse_package_v3(
        pkg_dir, transcripts_path=transcripts_path, run_whisper=False
    )
    Path(out_path).write_text(turtle)
    print(f"\nWrote {out_path} ({len(turtle):,} chars)")
    print(f"Stats: {json.dumps(stats, indent=2, default=str)}")
