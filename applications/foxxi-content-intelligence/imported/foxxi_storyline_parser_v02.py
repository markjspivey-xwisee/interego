"""
foxxi_storyline_parser_v02.py

v0.2 additions over v0.1:
  - Whisper narration transcription (fxs:NarrationTranscript nodes)
  - Slide-level alt-text + transcript text union as concept-extraction corpus
  - Heuristic concept extraction → fxk:Concept nodes with prefLabel + provenance
  - Heuristic prerequisite inference from slide ordering + concept co-occurrence
  - fxs:Slide subclass for cleaner queries
  - fxs:Scene subclass for scene-level grouping
  - All fxk: triples carry fxk:extractionConfidence
"""

import re
import json
import time
from pathlib import Path
from urllib.parse import quote
from xml.etree import ElementTree as ET
from datetime import datetime, timezone
from collections import Counter, defaultdict

# Reuse v0.1 extraction
import sys
sys.path.insert(0, str(Path(__file__).parent))
from foxxi_storyline_parser import (
    extract_global_provide_data,
    extract_global_provide_svg,
    parse_manifest,
    detect_authoring_tool,
    extract_storyline_content,
    _esc, _iri,
)


# ----------------------------------------------------------------------
# Whisper transcription
# ----------------------------------------------------------------------

def transcribe_audio(pkg_dir: Path, audio_relpaths, model_name="tiny.en"):
    """Transcribe a list of audio file paths (relative to pkg_dir)."""
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    
    transcripts = {}
    for relpath in audio_relpaths:
        full = pkg_dir / relpath
        if not full.exists():
            continue
        segments, info = model.transcribe(str(full), beam_size=1)
        segs = list(segments)
        transcripts[relpath] = {
            'duration': info.duration,
            'language': info.language,
            'text': ' '.join(s.text.strip() for s in segs),
            'segments': [
                {'start': s.start, 'end': s.end, 'text': s.text.strip()}
                for s in segs
            ],
        }
    return transcripts


def load_existing_transcripts(path: Path):
    if path.exists():
        return json.loads(path.read_text())
    return {}


# ----------------------------------------------------------------------
# Concept extraction (heuristic, replaceable with LLM/OLKE pipeline)
# ----------------------------------------------------------------------

# Domain stopwords for the corpus we're working with — would normally be
# tuned per-domain. The general pattern: common verbs, generic course
# language, function words.
COURSE_STOPWORDS = {
    # Generic course/learning language
    'lesson', 'course', 'objective', 'objectives', 'learning', 'student',
    'students', 'learner', 'welcome', 'introduction', 'conclusion',
    'thank', 'overview', 'topic', 'topics', 'session', 'completion',
    'complete', 'completed', 'understand', 'describe', 'explain',
    'discuss', 'review', 'aspects', 'options', 'shown', 'will', 'should',
    'able', 'next', 'previous', 'about', 'navigating', 'menu', 'page',
    'pages', 'click', 'select', 'audio', 'transcript', 'caption', 'video',
    'slide', 'slides', 'series', 'module', 'modules', 'part', 'first',
    'second', 'third', 'now', 'shown', 'show', 'shows', 'see', 'seen',
    'used', 'using',
    # English function words
    'this', 'that', 'these', 'those', 'with', 'which', 'where', 'when',
    'have', 'has', 'had', 'been', 'being', 'the', 'and', 'for', 'are',
    'was', 'were', 'but', 'not', 'any', 'all', 'some', 'such', 'than',
    'them', 'they', 'their', 'there', 'then', 'thus', 'therefore', 'also',
    'only', 'over', 'into', 'onto', 'between', 'among', 'before', 'after',
    'above', 'below', 'under', 'each', 'every', 'both', 'either', 'whose',
    'whom', 'whether', 'because', 'while', 'during', 'against', 'through',
    'within', 'without', 'because', 'though', 'although', 'however',
    'you', 'your', 'yours', 'we', 'our', 'ours', 'us', 'they', 'their',
    'her', 'him', 'his', 'hers', 'its', 'itself', 'themselves',
    'may', 'can', 'could', 'should', 'would', 'must', 'might', 'shall',
    'has', 'have', 'had', 'does', 'doing', 'did', 'done',
    # Branding / boilerplate
    'epri', 'electric', 'research', 'institute', 'rights', 'reserved',
    'copyright', 'inc', 'all', 'reserved',
    # Storyline alt-text junk (shape labels)
    'rectangle', 'square', 'circle', 'oval', 'arrow', 'triangle', 'shape',
    'group', 'image', 'picture', 'photo', 'icon', 'logo', 'background',
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'emf', 'wmf', 'mp3', 'mp4',
    'placeholder', 'text', 'label', 'title', 'subtitle', 'header',
    'footer', 'button', 'tab', 'panel', 'window', 'frame', 'border',
    'line', 'dot', 'dash', 'mark', 'point', 'edge', 'corner',
    # Player / UI
    'player', 'playbar', 'progress', 'bar', 'control', 'controls',
    'volume', 'mute', 'pause', 'play', 'stop', 'replay', 'fullscreen',
    'full-screen', 'screen', 'window', 'modal', 'dialog', 'popup',
    'glossary', 'resources', 'reference', 'references', 'help',
    'navigation', 'navbar', 'sidebar', 'panel', 'menu', 'home', 'exit',
    'enter', 'submit', 'cancel', 'close', 'open', 'toggle', 'expand',
    'collapse', 'show', 'hide', 'view', 'preview', 'edit', 'save',
    'load', 'reload', 'refresh', 'reset', 'clear', 'undo', 'redo',
    # Numerals as standalone tokens are usually shape labels (rectangle 7)
    # We allow them in multi-word phrases via the gram-level filter.
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten',
    # Generic verbs
    'use', 'uses', 'used', 'make', 'makes', 'made', 'get', 'gets',
    'got', 'go', 'goes', 'going', 'come', 'comes', 'came', 'take',
    'takes', 'took', 'taken', 'give', 'gives', 'gave', 'given',
    'find', 'finds', 'found', 'need', 'needs', 'needed', 'want',
    'wants', 'wanted', 'know', 'knows', 'knew', 'known',
    'think', 'thinks', 'thought', 'feel', 'feels', 'felt',
    'look', 'looks', 'looked', 'seem', 'seems', 'seemed',
    'become', 'becomes', 'became',
    # Common adverbs/connectors
    'just', 'still', 'very', 'really', 'quite', 'rather', 'fairly',
    'almost', 'nearly', 'mostly', 'generally', 'usually', 'often',
    'sometimes', 'always', 'never', 'ever', 'once', 'twice',
    'much', 'many', 'few', 'less', 'more', 'most', 'least',
    'good', 'better', 'best', 'bad', 'worse', 'worst',
    'same', 'different', 'similar', 'other', 'another', 'others',
    # Software-specific course UI
    'pps',
}


_STANDALONE_NUMERIC = re.compile(r'^[0-9]+$')


def _is_likely_storyline_artifact(phrase):
    """Filter out Storyline shape-label artifacts like 'rectangle 7' or 'image 41'."""
    tokens = phrase.split()
    # Single token that's purely numeric
    if len(tokens) == 1 and _STANDALONE_NUMERIC.match(tokens[0]):
        return True
    # Phrases like "rectangle 7" or "rectangle 9 rectangle" — common Storyline shape names
    shape_words = {'rectangle', 'oval', 'circle', 'square', 'triangle',
                    'arrow', 'shape', 'group', 'image', 'picture'}
    if any(t in shape_words for t in tokens):
        return True
    # Anything with 'emf' or 'png' etc as a token
    file_ext = {'emf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'wmf', 'mp3', 'mp4'}
    if any(t in file_ext for t in tokens):
        return True
    return False


def extract_concept_candidates(text, min_freq=1, ngram_range=(1, 3)):
    """
    Extract concept candidate phrases from text using simple n-gram + TF.
    
    Real implementation would use:
      - TextRank or KeyBERT for keyphrase extraction
      - Domain-specific NER (e.g., trained on power-systems literature)
      - LLM-based extraction validated against SHACL shapes
      - OLKE semiotic decomposition for sign/object/interpretant roles
    
    This heuristic is good enough to demonstrate the structural plumbing.
    """
    if not text:
        return []
    
    # Normalize
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s\-]', ' ', text)
    tokens = text.split()
    
    candidates = Counter()
    
    # Generate n-grams
    for n in range(ngram_range[0], ngram_range[1] + 1):
        for i in range(len(tokens) - n + 1):
            gram = tokens[i:i+n]
            # Filter out grams that are all stopwords or too short
            if all(t in COURSE_STOPWORDS for t in gram):
                continue
            if any(len(t) < 3 and not t.isdigit() for t in gram):
                continue
            # First/last token should not be stopword
            if gram[0] in COURSE_STOPWORDS or gram[-1] in COURSE_STOPWORDS:
                continue
            phrase = ' '.join(gram)
            # Drop Storyline shape-label artifacts
            if _is_likely_storyline_artifact(phrase):
                continue
            candidates[phrase] += 1
    
    # Score: frequency × log(length+1) — favors multi-word terms
    import math
    scored = [
        (phrase, count, count * math.log(len(phrase.split()) + 1))
        for phrase, count in candidates.items()
        if count >= min_freq
    ]
    scored.sort(key=lambda x: -x[2])
    return scored


def is_subphrase(phrase, container):
    """True if phrase is a strict sub-ngram of container."""
    p_tokens = phrase.split()
    c_tokens = container.split()
    if len(p_tokens) >= len(c_tokens):
        return False
    for i in range(len(c_tokens) - len(p_tokens) + 1):
        if c_tokens[i:i+len(p_tokens)] == p_tokens:
            return True
    return False


def _bag_key(phrase):
    """Bag-of-words signature: same words in any order get the same key."""
    return tuple(sorted(phrase.split()))


def consolidate_concepts(scored, top_k=8):
    """
    Pick top concept candidates, removing strict sub-phrases of higher-ranked ones,
    and deduplicating sliding-window permutations of the same word bag (preferring
    the highest-scoring ordering).
    """
    selected = []
    seen_bags = {}   # bag -> index in selected
    for phrase, count, score in scored:
        bag = _bag_key(phrase)
        if bag in seen_bags:
            continue   # earlier (higher-scoring) variant of same word bag wins
        if any(is_subphrase(phrase, s[0]) for s in selected):
            continue
        # Keep — but record bag
        seen_bags[bag] = len(selected)
        selected.append((phrase, count, score))
        if len(selected) >= top_k:
            break
    return selected


def extract_concepts_per_slide(slide_corpora):
    """
    Given {slide_id: combined_text}, extract concept candidates per slide
    and globally, return:
      - concepts: {concept_phrase: {slide_ids: [...], total_freq: N, confidence: 0..1}}
      - slide_concepts: {slide_id: [concept_phrases]}
    """
    # Per-slide candidate extraction
    slide_to_candidates = {}
    all_candidates = Counter()
    
    for sid, text in slide_corpora.items():
        scored = extract_concept_candidates(text, min_freq=1)
        # Take top concept candidates per slide. Higher top_k ensures
        # single-slide technical phrases survive into the keep filter.
        top = consolidate_concepts(scored, top_k=20)
        slide_to_candidates[sid] = top
        for phrase, count, _ in top:
            all_candidates[phrase] += count
    
    # Global deduplication: collapse permutations across slides too.
    # Pick the variant with highest cumulative frequency as the canonical name.
    bag_to_phrases = defaultdict(list)
    for phrase, total in all_candidates.items():
        bag_to_phrases[_bag_key(phrase)].append((phrase, total))
    
    canonical = {}   # phrase → canonical phrase
    for bag, phrases in bag_to_phrases.items():
        # Pick highest count; ties broken by alphabetical (deterministic)
        phrases.sort(key=lambda x: (-x[1], x[0]))
        canonical_phrase = phrases[0][0]
        for p, _ in phrases:
            canonical[p] = canonical_phrase
    
    # Rewrite slide_to_candidates and all_candidates to use canonical names
    new_all = Counter()
    for phrase, count in all_candidates.items():
        new_all[canonical[phrase]] += count
    all_candidates = new_all
    
    new_slide = {}
    for sid, top in slide_to_candidates.items():
        # Dedup canonical names within a slide
        seen = set()
        new_top = []
        for phrase, count, score in top:
            cp = canonical[phrase]
            if cp in seen:
                continue
            seen.add(cp)
            new_top.append((cp, count, score))
        new_slide[sid] = new_top
    slide_to_candidates = new_slide
    
    # Filter: a concept must appear with sufficient evidence.
    # Tiered:
    #   Tier 1 (high confidence): in 2+ slides
    #   Tier 2 (medium confidence): in 1 slide but appears 2+ times AND is multi-word
    #   Tier 3 (low confidence): in 1 slide, single occurrence, multi-word, length >= 2
    keep = set()
    tier_by_phrase = {}
    for phrase, total in all_candidates.items():
        in_slides = sum(
            1 for slide_cands in slide_to_candidates.values()
            if any(p == phrase for p, _, _ in slide_cands)
        )
        n_words = len(phrase.split())
        if in_slides >= 2:
            keep.add(phrase); tier_by_phrase[phrase] = 1
        elif in_slides == 1 and total >= 2 and n_words >= 2:
            keep.add(phrase); tier_by_phrase[phrase] = 2
        elif in_slides == 1 and n_words >= 2 and total >= 1:
            # Only keep tier-3 if not subsumed by something already kept
            # (we'll filter after we have the full set)
            keep.add(phrase); tier_by_phrase[phrase] = 3
    
    # Build output
    concepts = {}
    slide_concepts = {sid: [] for sid in slide_corpora}
    
    for phrase in keep:
        concepts[phrase] = {
            'slide_ids': [],
            'total_freq': all_candidates[phrase],
            'confidence': 0.0,
        }
    
    for sid, top in slide_to_candidates.items():
        for phrase, count, _ in top:
            if phrase in keep:
                concepts[phrase]['slide_ids'].append(sid)
                slide_concepts[sid].append(phrase)
    
    # Assign confidence: tier-driven, with adjustments for coverage and frequency
    tier_base = {1: 0.85, 2: 0.65, 3: 0.45}
    for phrase, info in concepts.items():
        tier = tier_by_phrase.get(phrase, 3)
        coverage = len(info['slide_ids']) / max(1, len(slide_corpora))
        freq_factor = min(1.0, info['total_freq'] / 5.0)
        base = tier_base[tier]
        bonus = coverage * 0.05 + freq_factor * 0.05
        info['confidence'] = round(min(0.95, base + bonus), 2)
        info['tier'] = tier
    
    return concepts, slide_concepts


def infer_prerequisites(slide_concepts, slide_order):
    """
    Heuristic: if concept A appears (first introduced) in slide N and
    concept B appears in slide M > N, AND the slides appear in pedagogical
    order, then A is a candidate prerequisite of B if they co-occur in
    later slides.
    
    Real version would use:
      - LLM analysis of definitional vs applicative usage
      - Discourse markers ("now that we understand X, we can discuss Y")
      - Cross-slide concept reference patterns
      - The OLKE sign-object-interpretant decomposition to identify
        which concepts function as priors vs which function as targets
    """
    # First-appearance index per concept
    first_seen = {}
    for idx, sid in enumerate(slide_order):
        for c in slide_concepts.get(sid, []):
            if c not in first_seen:
                first_seen[c] = idx
    
    # For each pair (A, B) where A appears first and B later, in some
    # later slide both occur — A is a candidate prereq of B
    co_later = defaultdict(int)
    for idx, sid in enumerate(slide_order):
        cs = slide_concepts.get(sid, [])
        for a in cs:
            for b in cs:
                if a == b: continue
                if first_seen.get(a, 999) < first_seen.get(b, 999) < idx:
                    # A and B both appear in slide idx, but A came first and
                    # B was introduced before idx
                    pass  # not a prereq signal
                if first_seen.get(a, 999) < first_seen.get(b, -1) <= idx:
                    if first_seen[a] < first_seen[b]:
                        co_later[(a, b)] += 1
    
    # Threshold: a prereq edge needs at least one co-occurrence in a slide
    # later than B's first appearance, AND A must appear in 2+ slides
    edges = []
    for (a, b), count in co_later.items():
        if count >= 1 and first_seen[a] < first_seen[b]:
            edges.append((a, b, count))
    
    # Confidence: strength is normalized by max count
    max_count = max((c for _, _, c in edges), default=1)
    edges_with_conf = [
        (a, b, round(0.4 + 0.5 * (c / max_count), 2))
        for a, b, c in edges
    ]
    return edges_with_conf


# ----------------------------------------------------------------------
# Turtle emission (v0.2 — adds fxk: stratum + transcripts)
# ----------------------------------------------------------------------

PREAMBLE_V2 = '''@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
@prefix sh:      <http://www.w3.org/ns/shacl#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix schema:  <http://schema.org/> .
@prefix skos:    <http://www.w3.org/2004/02/skos/core#> .
@prefix cnt:     <http://www.w3.org/2011/content#> .
@prefix fxs:     <https://vocab.foxximediums.com/scorm#> .
@prefix fxk:     <https://vocab.foxximediums.com/knowledge#> .
@prefix fxsh:    <https://vocab.foxximediums.com/shapes#> .

# ─── v0.2 vocabulary extensions (declared inline pending vocab v0.2) ───
# Slide is both an Item (so it composes into the pedagogical tree) AND
# a Resource (so it can carry a fileLocator and embed assets directly).
# This dual nature reflects the reality of slide-based authoring.
fxs:Slide a rdfs:Class ;
    rdfs:subClassOf fxs:Item, fxs:Resource ;
    rdfs:label "Slide" ;
    rdfs:comment "A leaf-level pedagogical unit, typically authored as a single screen with optional narration. Functions both as an Item in the organization tree and as a Resource carrying content." .

fxs:Scene a rdfs:Class ;
    rdfs:subClassOf fxs:Item ;
    rdfs:label "Scene" ;
    rdfs:comment "A grouping of related slides, used by some authoring tools (e.g. Storyline) to organize content into chapters." .

fxs:NarrationTranscript a rdfs:Class ;
    rdfs:label "Narration Transcript" ;
    rdfs:comment "Text content of a narration audio track, typically produced by ASR." .

fxs:hasNarration a rdf:Property ;
    rdfs:label "has narration" ;
    rdfs:domain fxs:Item ;
    rdfs:range fxs:NarrationTranscript .

fxs:transcribedBy a rdf:Property ;
    rdfs:label "transcribed by" ;
    rdfs:range prov:Agent .

fxs:extractedTextCorpus a rdf:Property ;
    rdfs:label "extracted text corpus" ;
    rdfs:comment "Collected text content from a Resource (alt-text, on-screen labels, etc.) used as input for semantic extraction." .

# Override v0.1 ItemShape: a Slide is self-contained (Item ∩ Resource)
# and need not reference an external Resource. v0.2 vocabulary will
# refactor ItemShape to scope by class rather than carry this exception.
fxsh:SlideShape a sh:NodeShape ;
    sh:targetClass fxs:Slide ;
    sh:property [
        sh:path fxs:identifiedBy ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:string ;
    ] ;
    sh:property [
        sh:path fxs:fileLocator ;
        sh:minCount 1 ;
        sh:datatype xsd:string ;
    ] .

'''


def slugify(s, max_len=60):
    """Slug for a concept phrase to use in URIs."""
    s = re.sub(r'[^a-z0-9\s-]', '', s.lower())
    s = re.sub(r'\s+', '-', s.strip())
    return s[:max_len].rstrip('-')


def emit_turtle_v2(manifest, content, transcripts, concepts, slide_concepts,
                    prereq_edges, slide_id_to_audio_urls,
                    pkg_iri_base, parser_iri, extracted_at):
    """v0.2 emission with full fxk: stratum."""
    lines = [PREAMBLE_V2]
    pkg_iri = f'<{pkg_iri_base}>'
    
    # ==== Package ====
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
    for org_iri, is_default in org_iris:
        if is_default:
            lines.append(f'    fxs:defaultOrganization {org_iri} ;')
            break
    
    lines.append(f'    prov:wasGeneratedBy <{parser_iri}> ;')
    lines.append(f'    prov:generatedAtTime "{extracted_at}"^^xsd:dateTime .')
    lines.append('')
    
    # Organization
    for org in manifest['organizations']:
        org_iri = _iri(pkg_iri_base, 'org', org['id'])
        lines.append(f'{org_iri} a fxs:Organization ;')
        lines.append(f'    dcterms:title "{_esc(org["title"])}" ;')
        lines.append(f'    fxs:identifiedBy "{org["id"]}" ;')
        item_iris = [_iri(pkg_iri_base, 'item', it['id']) for it in org['items']]
        if item_iris:
            lines.append(f'    fxs:hasItem {", ".join(item_iris)} .')
        lines.append('')
    
    # Manifest items
    def emit_item(item, depth=0, sequence_index=0):
        item_iri = _iri(pkg_iri_base, 'item', item['id'])
        lines.append(f'{item_iri} a fxs:Item ;')
        lines.append(f'    dcterms:title "{_esc(item["title"])}" ;')
        lines.append(f'    fxs:identifiedBy "{item["id"]}" ;')
        lines.append(f'    fxs:sequenceIndex {sequence_index} ;')
        if item['children']:
            child_iris = [_iri(pkg_iri_base, 'item', c['id']) for c in item['children']]
            lines.append(f'    fxs:hasChild {", ".join(child_iris)} ;')
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
    
    # Manifest resources
    for res_id, res in manifest['resources'].items():
        res_iri = _iri(pkg_iri_base, 'res', res_id)
        cls = 'fxs:SCO' if res.get('scorm_type') == 'sco' else 'fxs:Asset'
        lines.append(f'{res_iri} a {cls} ;')
        lines.append(f'    fxs:identifiedBy "{res_id}" ;')
        if res.get('href'):
            lines.append(f'    fxs:fileLocator "package!/{res["href"]}" ;')
        lines.append(f'    prov:wasDerivedFrom {pkg_iri} .')
        lines.append('')
    
    # ==== Storyline scenes & slides ====
    if not content or not content.get('scenes'):
        return '\n'.join(lines)
    
    sco_res = next((r for r in manifest['resources'].values() if r.get('scorm_type') == 'sco'), None)
    sco_iri = _iri(pkg_iri_base, 'res', sco_res['id']) if sco_res else pkg_iri
    
    lines.append('# ─── Storyline scenes & slides ───')
    lines.append('')
    
    slide_iri_by_id = {}
    
    for scene_idx, scene in enumerate(content['scenes']):
        scene_iri = _iri(pkg_iri_base, 'scene', scene['id'])
        lines.append(f'{scene_iri} a fxs:Scene, fxs:Item ;')
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
            lines.append(f'{slide_iri} a fxs:Slide, fxs:Item ;')
            lines.append(f'    dcterms:title "{_esc(slide["title"])}" ;')
            lines.append(f'    fxs:identifiedBy "{slide["id"]}" ;')
            lines.append(f'    fxs:sequenceIndex {slide_idx} ;')
            lines.append(f'    fxs:fileLocator "package!/html5/data/js/{slide["id"]}.js" ;')
            # Slide is its own Resource — satisfies ItemShape's hasResource constraint
            lines.append(f'    fxs:hasResource {slide_iri} ;')
            lines.append(f'    prov:wasDerivedFrom {sco_iri} ;')
            if slide.get('lms_id'):
                lines.append(f'    schema:identifier "{slide["lms_id"]}" ;')
            
            # Audio assets
            for au in slide['audio_urls']:
                asset_iri = _iri(pkg_iri_base, 'asset', au)
                lines.append(f'    fxs:embedsAsset {asset_iri} ;')
            
            # Narration transcripts → fxs:hasNarration
            for au in slide['audio_urls']:
                if au in transcripts:
                    nar_iri = _iri(pkg_iri_base, 'narration', au)
                    lines.append(f'    fxs:hasNarration {nar_iri} ;')
            
            # Alt-text corpus
            if slide['alt_text_corpus']:
                clean = '; '.join(set(t for t in slide['alt_text_corpus']
                                       if t and t != 'Image 41.emf'))[:1000]
                if clean:
                    lines.append(f'    fxs:extractedTextCorpus "{_esc(clean)}" ;')
            
            # Close slide statement
            if lines[-1].endswith(' ;'):
                lines[-1] = lines[-1][:-2] + ' .'
            else:
                lines.append('    .')
            lines.append('')
            
            # Audio + narration nodes
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
    
    # ==== fxk: Semantic stratum ====
    lines.append('# ═══════════════════════════════════════════════════')
    lines.append('# SEMANTIC STRATUM (fxk:)')
    lines.append('# Concepts and prerequisite relations extracted from')
    lines.append('# combined alt-text + narration transcripts.')
    lines.append('# ═══════════════════════════════════════════════════')
    lines.append('')
    
    concept_iri_by_phrase = {}
    for phrase, info in concepts.items():
        cid = slugify(phrase)
        if not cid:
            continue
        concept_iri = _iri(pkg_iri_base, 'concept', cid)
        concept_iri_by_phrase[phrase] = concept_iri
        
        lines.append(f'{concept_iri} a fxk:Concept ;')
        lines.append(f'    skos:prefLabel "{_esc(phrase)}" ;')
        lines.append(f'    fxk:extractionConfidence {info["confidence"]} ;')
        # Link to slides where this concept is taught
        taught_in = []
        for sid in info['slide_ids']:
            if sid in slide_iri_by_id:
                taught_in.append(slide_iri_by_id[sid])
        for ti in taught_in[:5]:
            lines.append(f'    fxk:taughtIn {ti} ;')
        # Provenance back to the slide-resources / narrations
        prov_sources = []
        for sid in info['slide_ids']:
            if sid in slide_iri_by_id:
                prov_sources.append(slide_iri_by_id[sid])
        for ps in prov_sources[:3]:
            lines.append(f'    prov:wasDerivedFrom {ps} ;')
        lines.append(f'    prov:wasGeneratedBy <{parser_iri}#concept-extractor> .')
        lines.append('')
    
    # Prerequisite edges
    if prereq_edges:
        lines.append('# ─── Prerequisite relations (heuristic v0.2) ───')
        lines.append('')
        for a, b, conf in prereq_edges:
            if a not in concept_iri_by_phrase or b not in concept_iri_by_phrase:
                continue
            a_iri = concept_iri_by_phrase[a]
            b_iri = concept_iri_by_phrase[b]
            lines.append(f'{a_iri} fxk:prerequisiteOf {b_iri} .')
        lines.append('')
    
    # ==== Parser provenance ====
    lines.append('# ─── Parser provenance ───')
    lines.append(f'<{parser_iri}> a prov:SoftwareAgent ;')
    lines.append(f'    rdfs:label "foxxi-storyline-parser" ;')
    lines.append(f'    schema:softwareVersion "0.2.0" .')
    lines.append('')
    lines.append(f'<{parser_iri}#concept-extractor> a prov:SoftwareAgent ;')
    lines.append(f'    rdfs:label "foxxi heuristic concept extractor v0.2" ;')
    lines.append(f'    rdfs:comment "n-gram TF + slide-coverage heuristic; v0.3 will use LLM-backed OLKE decomposition." .')
    lines.append('')
    
    return '\n'.join(lines)


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

def parse_package_v2(pkg_dir: str, transcripts_path=None, run_whisper=True,
                     pkg_iri_base=None, parser_iri=None):
    pkg_dir = Path(pkg_dir)
    
    manifest = parse_manifest(pkg_dir / 'imsmanifest.xml')
    tool, version = detect_authoring_tool(pkg_dir)
    print(f"Authoring tool: {tool}  (version: {version})")
    
    content = None
    if tool == 'fxs:ArticulateStoryline':
        content = extract_storyline_content(pkg_dir)
    
    # Collect audio file paths
    audio_relpaths = set()
    for scene in (content or {}).get('scenes', []):
        for slide in scene['slides']:
            for au in slide['audio_urls']:
                audio_relpaths.add(au)
    
    # Transcripts
    transcripts = {}
    if transcripts_path and Path(transcripts_path).exists():
        transcripts = json.loads(Path(transcripts_path).read_text())
        print(f"Loaded {len(transcripts)} cached transcripts")
    elif run_whisper:
        print(f"Transcribing {len(audio_relpaths)} audio files with whisper...")
        transcripts = transcribe_audio(pkg_dir, audio_relpaths)
        if transcripts_path:
            Path(transcripts_path).write_text(json.dumps(transcripts, indent=2))
            print(f"Saved transcripts to {transcripts_path}")
    
    # Build per-slide text corpus.
    # Narration transcripts are the primary signal because alt-text in
    # Storyline is mostly shape names. Title is used once as a header.
    # Alt-text is excluded from the concept-extraction corpus but remains
    # in the RDF output as fxs:extractedTextCorpus for downstream uses.
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
    
    # Concept extraction
    print(f"Extracting concepts from {len(slide_corpora)} slides...")
    concepts, slide_concepts = extract_concepts_per_slide(slide_corpora)
    print(f"  -> {len(concepts)} concepts above evidence threshold")
    
    # Prerequisite inference
    prereq_edges = infer_prerequisites(slide_concepts, slide_order)
    print(f"  -> {len(prereq_edges)} prerequisite edges")
    
    # Emit
    pkg_iri_base = pkg_iri_base or f'https://example.foxximediums.com/pkg/{manifest["package_id"]}'
    parser_iri = parser_iri or 'https://vocab.foxximediums.com/parsers/storyline/0.2.0'
    extracted_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    
    turtle = emit_turtle_v2(manifest, content, transcripts, concepts, slide_concepts,
                              prereq_edges, slide_id_to_audio_urls,
                              pkg_iri_base, parser_iri, extracted_at)
    
    # Stats
    stats = {
        'manifest_items': sum(len(o['items']) for o in manifest['organizations']),
        'manifest_resources': len(manifest['resources']),
        'scenes': len((content or {}).get('scenes', [])),
        'slides': len(slide_order),
        'audio_files': len(audio_relpaths),
        'transcripts': len(transcripts),
        'audio_seconds': sum(t['duration'] for t in transcripts.values()),
        'concepts': len(concepts),
        'prereq_edges': len(prereq_edges),
    }
    
    return turtle, stats, manifest, content, concepts, slide_concepts, prereq_edges, transcripts


if __name__ == '__main__':
    import sys
    pkg_dir = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/storyline-test'
    out_path = sys.argv[2] if len(sys.argv) > 2 else '/home/claude/storyline-test/lesson3_v02.ttl'
    
    transcripts_path = Path(pkg_dir) / 'transcripts.json'
    
    turtle, stats, *_ = parse_package_v2(
        pkg_dir,
        transcripts_path=str(transcripts_path),
        run_whisper=True,
    )
    
    Path(out_path).write_text(turtle)
    print(f"\nWrote {out_path} ({len(turtle)} chars)")
    print(f"Stats: {json.dumps(stats, indent=2, default=str)}")
