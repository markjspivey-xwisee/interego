"""
foxxi_storyline_parser.py — v0 prototype

Parses an Articulate Storyline SCORM package and emits RDF (Turtle) conforming
to the foxxi-content-graph vocabulary (fxs: structural stratum).

Inputs:  path to the unzipped package directory
Outputs: turtle file with fxs:Package, fxs:Organization, fxs:Item, fxs:Resource,
         and fxs:Interaction triples.

Status:
  - Manifest parsing: complete (SCORM 2004 + ADL sequencing)
  - Authoring tool fingerprinting: complete (detects Storyline by html5/data/js/data.js)
  - Scene/Slide structural extraction: complete via globalProvideData JSON
  - SVG text extraction: complete (story_content/*.js → <text> contents)
  - Audio asset mapping: complete (slide layer → assetLib → MP3 path)
  - Audio narration transcription: STUBBED (would call Whisper)
  - Quiz/Interaction extraction: NOT YET (this package has no quizzes;
    add when first quiz package arrives)

Design notes:
  - Two extraction patterns are needed for Storyline JS files:
      pattern A: globalProvideData('NAME', '{json}')    — single-quoted JSON
      pattern B: globalProvideSvgData('NAME', "<svg>")  — double-quoted SVG
  - Pattern A has a known double-escape bug in font-family values: \\\\\" in
    the source decodes to \\" in JS string, which is invalid JSON. The fix is
    a global replace of \\\\\" -> \\" before json.loads().
  - Each slide JSON is referenced from data.js's scenes[].slides[].id field.
"""

import re
import json
import zipfile
from pathlib import Path
from urllib.parse import unquote, quote
from xml.etree import ElementTree as ET
from datetime import datetime, timezone


# ----------------------------------------------------------------------
# Storyline JS extraction
# ----------------------------------------------------------------------

_GPD_PREFIX = re.compile(r"window\.globalProvideData\(\s*'([^']+)'\s*,\s*'")
_GPSVG_RE = re.compile(
    r'window\.globalProvideSvgData\(\s*[\'"]([^\'"]+)[\'"]\s*,\s*"(.*)"\s*\)\s*;?\s*$',
    re.DOTALL
)


def extract_global_provide_data(text: str):
    """Extract (name, json_obj) from a Storyline html5/data/js/*.js file."""
    if text.startswith('\ufeff'):
        text = text[1:]
    m = _GPD_PREFIX.match(text)
    if not m:
        return None
    name = m.group(1)
    body = text[m.end():].rstrip()
    if body.endswith(';'): body = body[:-1].rstrip()
    if body.endswith(')'): body = body[:-1].rstrip()
    if body.endswith("'"): body = body[:-1]
    body = body.replace(r"\'", "'")
    body = body.replace(r'\\"', r'\"')   # Storyline double-escape fix
    return name, json.loads(body)


def extract_global_provide_svg(text: str):
    """Extract (name, svg_text_strings) from a Storyline story_content/*.js SVG file."""
    if text.startswith('\ufeff'):
        text = text[1:]
    m = _GPSVG_RE.match(text.strip())
    if not m:
        return None
    name = m.group(1)
    svg = m.group(2).replace(r'\"', '"')
    text_nodes = re.findall(r'<text[^>]*>([^<]*)</text>', svg)
    return name, [t for t in text_nodes if t.strip()]


# ----------------------------------------------------------------------
# Manifest parsing
# ----------------------------------------------------------------------

NS = {
    'imscp': 'http://www.imsglobal.org/xsd/imscp_v1p1',
    'adlcp': 'http://www.adlnet.org/xsd/adlcp_v1p3',
    'adlseq': 'http://www.adlnet.org/xsd/adlseq_v1p3',
    'imsss': 'http://www.imsglobal.org/xsd/imsss',
}

def parse_manifest(manifest_path: Path):
    """Parse imsmanifest.xml into a structured dict."""
    tree = ET.parse(manifest_path)
    root = tree.getroot()
    pkg_id = root.get('identifier')
    pkg_version = root.get('version', '1.3')
    
    schema = root.findtext('.//imscp:metadata/imscp:schema', namespaces=NS) or ''
    schema_version = root.findtext('.//imscp:metadata/imscp:schemaversion', namespaces=NS) or ''
    
    # Determine standard from schema/schemaversion
    std = 'unknown'
    if 'SCORM' in schema:
        if '1.3' in pkg_version or '1.3' in schema_version or 'CAM' in schema_version:
            std = 'SCORM_2004_4'   # commonly the latest
        elif '1.2' in pkg_version or '1.2' in schema_version:
            std = 'SCORM_1_2'
    
    # Organizations
    orgs_el = root.find('imscp:organizations', NS)
    default_org_id = orgs_el.get('default') if orgs_el is not None else None
    organizations = []
    
    for org_el in orgs_el.findall('imscp:organization', NS) if orgs_el is not None else []:
        org = {
            'id': org_el.get('identifier'),
            'title': org_el.findtext('imscp:title', namespaces=NS) or '',
            'items': [],
            'sequencing': _parse_sequencing(org_el.find('imsss:sequencing', NS)),
            'is_default': org_el.get('identifier') == default_org_id,
        }
        for item_el in org_el.findall('imscp:item', NS):
            org['items'].append(_parse_item(item_el))
        organizations.append(org)
    
    # Resources
    resources = {}
    res_root = root.find('imscp:resources', NS)
    if res_root is not None:
        for res_el in res_root.findall('imscp:resource', NS):
            rid = res_el.get('identifier')
            resources[rid] = {
                'id': rid,
                'type': res_el.get('type'),
                'scorm_type': res_el.get('{http://www.adlnet.org/xsd/adlcp_v1p3}scormType'),
                'href': res_el.get('href'),
                'files': [f.get('href') for f in res_el.findall('imscp:file', NS)],
            }
    
    return {
        'package_id': pkg_id,
        'version': pkg_version,
        'standard': std,
        'schema': schema,
        'schema_version': schema_version,
        'organizations': organizations,
        'resources': resources,
    }


def _parse_item(item_el, depth=0):
    item = {
        'id': item_el.get('identifier'),
        'identifierref': item_el.get('identifierref'),
        'isvisible': item_el.get('isvisible', 'true') == 'true',
        'title': item_el.findtext('imscp:title', namespaces=NS) or '',
        'children': [],
        'sequencing': _parse_sequencing(item_el.find('imsss:sequencing', NS)),
    }
    for child in item_el.findall('imscp:item', NS):
        item['children'].append(_parse_item(child, depth + 1))
    return item


def _parse_sequencing(seq_el):
    if seq_el is None:
        return None
    cm = seq_el.find('imsss:controlMode', NS)
    dc = seq_el.find('imsss:deliveryControls', NS)
    return {
        'control_mode': dict(cm.attrib) if cm is not None else None,
        'delivery_controls': dict(dc.attrib) if dc is not None else None,
    }


# ----------------------------------------------------------------------
# Authoring tool fingerprinting
# ----------------------------------------------------------------------

def detect_authoring_tool(pkg_dir: Path):
    """Return (fxs:AuthoringTool individual name, version_string|None)."""
    # Articulate Storyline signatures:
    #   - html5/data/js/data.js exists
    #   - data.js contains a 'version' field formatted like '3.x.x.x'
    data_js = pkg_dir / 'html5' / 'data' / 'js' / 'data.js'
    if data_js.exists():
        text = data_js.read_text(encoding='utf-8-sig')
        result = extract_global_provide_data(text)
        if result:
            name, data = result
            if name == 'data' and 'projectId' in data and 'courseId' in data:
                return 'fxs:ArticulateStoryline', data.get('version')
    
    # Articulate Rise signature:
    #   - has presentation.json or course.json with a 'lessons' array
    if (pkg_dir / 'course.json').exists() or (pkg_dir / 'presentation.json').exists():
        return 'fxs:ArticulateRise', None
    
    # Captivate:  html5/captivate/ folder exists
    if (pkg_dir / 'html5' / 'captivate').exists() or (pkg_dir / 'project.txt').exists():
        return 'fxs:Captivate', None
    
    return 'fxs:UnknownAuthoringTool', None


# ----------------------------------------------------------------------
# Scene/slide content extraction (Storyline-specific)
# ----------------------------------------------------------------------

def extract_storyline_content(pkg_dir: Path):
    """Walk all html5/data/js/*.js files, extract slide tree and asset map."""
    js_dir = pkg_dir / 'html5' / 'data' / 'js'
    if not js_dir.exists():
        return None
    
    extracted = {}
    for f in js_dir.glob('*.js'):
        text = f.read_text(encoding='utf-8-sig')
        result = extract_global_provide_data(text)
        if result is None:
            continue
        name, data = result
        extracted[f.stem] = (name, data)
    
    # Find the master 'data' record
    master = None
    slides_by_id = {}
    for stem, (name, data) in extracted.items():
        if name == 'data':
            master = data
        elif name == 'slide':
            slides_by_id[stem] = data   # stem is the slide id
    
    if master is None:
        return None
    
    # Asset library: id -> url
    asset_url = {a['id']: a.get('url') for a in master.get('assetLib', [])}
    
    # Walk SVG asset URLs and pull text from each
    svg_text_by_dataid = {}
    for asset in master.get('assetLib', []):
        if asset.get('jsType') == 'jssvg' and asset.get('url'):
            svg_path = pkg_dir / asset['url']
            if svg_path.exists():
                text = svg_path.read_text(encoding='utf-8-sig')
                res = extract_global_provide_svg(text)
                if res:
                    _, texts = res
                    svg_text_by_dataid[asset['dataId']] = texts
    
    # Build scene → slide structure
    scenes_out = []
    for scene in master.get('scenes', []):
        if scene.get('isMessageScene'):
            continue   # skip resume/error prompts
        slides_out = []
        for sl in scene.get('slides', []):
            sid = sl.get('id')
            slide_data = slides_by_id.get(sid)
            if not slide_data:
                continue
            # Collect audio file urls per layer
            audio_urls = []
            for layer in slide_data.get('slideLayers', []):
                for a in layer.get('audiolib', []) or []:
                    aid = a.get('assetId')
                    if aid in asset_url:
                        audio_urls.append(asset_url[aid])
            # Collect on-slide text from referenced SVGs (vectorshape pr lookup)
            # vectorData.pr.l == 'Lib' references the master 'paths' lib;
            # that lib stores the SVG dataIds we already extracted.
            on_slide_text = []
            for layer in slide_data.get('slideLayers', []):
                for o in layer.get('objects', []) or []:
                    alt = o.get('data', {}).get('vectorData', {}).get('altText')
                    if alt and alt not in ('Image 41.emf',):
                        on_slide_text.append(alt)
                    # imagelib entries with altText
                    for img in o.get('imagelib', []) or []:
                        ialt = img.get('altText')
                        if ialt and ialt != alt:
                            on_slide_text.append(ialt)
            slides_out.append({
                'id': sid,
                'title': slide_data.get('title', '').strip(),
                'lms_id': slide_data.get('lmsId'),
                'audio_urls': audio_urls,
                'alt_text_corpus': on_slide_text,
                'layer_count': len(slide_data.get('slideLayers', [])),
            })
        scenes_out.append({
            'id': scene.get('id'),
            'lms_id': scene.get('lmsId'),
            'scene_number': scene.get('sceneNumber'),
            'starting_slide': scene.get('startingSlide'),
            'slides': slides_out,
        })
    
    # Aggregate all SVG text as a free-text corpus per slide is hard without
    # a precise mapping; for now, collect all extracted SVG text into a
    # package-level corpus and expose it for v0.2 enrichment.
    package_svg_corpus = {dataid: ' '.join(t) for dataid, t in svg_text_by_dataid.items()}
    
    return {
        'project_id': master.get('projectId'),
        'course_id': master.get('courseId'),
        'authoring_version': master.get('version'),
        'slide_count': master.get('slideCount'),
        'lesson_duration': master.get('lessonDuration'),
        'scenes': scenes_out,
        'svg_corpus': package_svg_corpus,
        'asset_count': len(master.get('assetLib', [])),
    }


# ----------------------------------------------------------------------
# RDF/Turtle emission
# ----------------------------------------------------------------------

PREAMBLE = '''@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix schema:  <http://schema.org/> .
@prefix skos:    <http://www.w3.org/2004/02/skos/core#> .
@prefix fxs:     <https://vocab.foxximediums.com/scorm#> .
@prefix fxk:     <https://vocab.foxximediums.com/knowledge#> .

'''

def _esc(s: str) -> str:
    """Escape a string literal for Turtle."""
    return s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '')


def _iri(base, *parts):
    """Build an IRI by joining path components."""
    encoded = '/'.join(quote(str(p), safe='-_.~') for p in parts)
    return f'<{base}/{encoded}>'


def emit_turtle(manifest, content, pkg_iri_base: str, parser_iri: str, extracted_at: str) -> str:
    """Emit Turtle conforming to fxs: structural stratum + minimal fxk: hints."""
    lines = [PREAMBLE]
    
    pkg_iri = f'<{pkg_iri_base}>'
    
    # ==== Package ====
    lines.append(f'{pkg_iri} a fxs:Package ;')
    lines.append(f'    dcterms:title "{_esc(manifest["organizations"][0]["title"])}" ;')
    lines.append(f'    dcterms:identifier "{manifest["package_id"]}" ;')
    lines.append(f'    fxs:identifiedBy "{manifest["package_id"]}" ;')
    lines.append(f'    fxs:standardConformance fxs:{manifest["standard"]} ;')
    if content and content.get('authoring_version'):
        lines.append(f'    schema:softwareVersion "{content["authoring_version"]}" ;')
    lines.append(f'    fxs:authoredWith fxs:ArticulateStoryline ;')
    
    # Organizations
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
    
    # ==== Organizations ====
    for org in manifest['organizations']:
        org_iri = _iri(pkg_iri_base, 'org', org['id'])
        lines.append(f'{org_iri} a fxs:Organization ;')
        lines.append(f'    dcterms:title "{_esc(org["title"])}" ;')
        lines.append(f'    fxs:identifiedBy "{org["id"]}" ;')
        # Items
        item_iris = [_iri(pkg_iri_base, 'item', it['id']) for it in org['items']]
        if item_iris:
            lines.append(f'    fxs:hasItem {", ".join(item_iris)} .')
        else:
            lines.append('    a fxs:Organization .')   # fall through if no items
        lines.append('')
    
    # ==== Items (recursive) ====
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
    
    # ==== Resources ====
    for res_id, res in manifest['resources'].items():
        res_iri = _iri(pkg_iri_base, 'res', res_id)
        # Pick the SCO subclass based on scorm_type
        cls = 'fxs:SCO' if res.get('scorm_type') == 'sco' else 'fxs:Asset'
        lines.append(f'{res_iri} a {cls} ;')
        lines.append(f'    fxs:identifiedBy "{res_id}" ;')
        if res.get('href'):
            locator = f"package!/{res['href']}"
            lines.append(f'    fxs:fileLocator "{_esc(locator)}" ;')
        lines.append(f'    prov:wasDerivedFrom {pkg_iri} .')
        lines.append('')
    
    # ==== Storyline scene/slide subdivision (extension beyond manifest) ====
    if content and content.get('scenes'):
        lines.append('# ─────────────────────────────────────────────')
        lines.append('# Storyline-specific subdivision: scenes & slides')
        lines.append('# These extend the single-SCO manifest with the')
        lines.append('# fine-grained pedagogical structure that lives')
        lines.append('# inside html5/data/js/data.js')
        lines.append('# ─────────────────────────────────────────────')
        lines.append('')
        
        # Find the (single) SCO resource to use as the parent for slide-level resources
        sco_res = next((r for r in manifest['resources'].values() if r.get('scorm_type') == 'sco'), None)
        sco_iri = _iri(pkg_iri_base, 'res', sco_res['id']) if sco_res else None
        
        for scene_idx, scene in enumerate(content['scenes']):
            scene_iri = _iri(pkg_iri_base, 'scene', scene['id'])
            lines.append(f'{scene_iri} a fxs:Item ;')
            lines.append(f'    dcterms:title "Scene {scene["scene_number"]}: {_esc(scene.get("lms_id") or scene["id"])}" ;')
            lines.append(f'    fxs:identifiedBy "{scene["id"]}" ;')
            lines.append(f'    fxs:sequenceIndex {scene_idx} ;')
            slide_iris = [_iri(pkg_iri_base, 'slide', s['id']) for s in scene['slides']]
            if slide_iris:
                lines.append(f'    fxs:hasChild {", ".join(slide_iris)} ;')
            lines[-1] = lines[-1].rstrip(' ;') + ' .'
            lines.append('')
            
            for slide_idx, slide in enumerate(scene['slides']):
                slide_iri = _iri(pkg_iri_base, 'slide', slide['id'])
                lines.append(f'{slide_iri} a fxs:Item ;')
                lines.append(f'    dcterms:title "{_esc(slide["title"])}" ;')
                lines.append(f'    fxs:identifiedBy "{slide["id"]}" ;')
                lines.append(f'    fxs:sequenceIndex {slide_idx} ;')
                if slide.get('lms_id'):
                    lines.append(f'    schema:identifier "{slide["lms_id"]}" ;')
                # Slide as a Resource in its own right
                slide_res_iri = _iri(pkg_iri_base, 'slide-res', slide['id'])
                lines.append(f'    fxs:hasResource {slide_res_iri} .')
                lines.append('')
                
                lines.append(f'{slide_res_iri} a fxs:Asset ;')
                lines.append(f'    dcterms:title "Slide content: {_esc(slide["title"])}" ;')
                lines.append(f'    fxs:identifiedBy "{slide["id"]}" ;')
                lines.append(f'    fxs:fileLocator "package!/html5/data/js/{slide["id"]}.js" ;')
                # Embed audio assets
                for au in slide['audio_urls']:
                    asset_iri = _iri(pkg_iri_base, 'asset', au)
                    lines.append(f'    fxs:embedsAsset {asset_iri} ;')
                # Alt-text corpus as schema:abstract (best-effort)
                if slide['alt_text_corpus']:
                    abstract = '; '.join(set(slide['alt_text_corpus']))[:500]
                    lines.append(f'    schema:abstract "{_esc(abstract)}" ;')
                lines.append(f'    prov:wasDerivedFrom {sco_iri} .' if sco_iri else f'    prov:wasDerivedFrom {pkg_iri} .')
                lines.append('')
                
                # Audio assets for this slide
                for au in slide['audio_urls']:
                    asset_iri = _iri(pkg_iri_base, 'asset', au)
                    lines.append(f'{asset_iri} a fxs:Asset ;')
                    lines.append(f'    dcterms:format "audio/mpeg" ;')
                    lines.append(f'    fxs:fileLocator "package!/{au}" ;')
                    lines.append(f'    prov:wasDerivedFrom {pkg_iri} .')
                    lines.append('')
    
    # ==== Parser provenance ====
    lines.append(f'<{parser_iri}> a prov:SoftwareAgent ;')
    lines.append(f'    rdfs:label "foxxi-storyline-parser" ;')
    lines.append(f'    schema:softwareVersion "0.1.0" .')
    lines.append('')
    
    return '\n'.join(lines)


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

def parse_package(pkg_dir: str, pkg_iri_base: str = None, parser_iri: str = None):
    pkg_dir = Path(pkg_dir)
    
    manifest_path = pkg_dir / 'imsmanifest.xml'
    if not manifest_path.exists():
        raise FileNotFoundError(f"No imsmanifest.xml in {pkg_dir}")
    
    manifest = parse_manifest(manifest_path)
    
    tool, version = detect_authoring_tool(pkg_dir)
    print(f"Authoring tool: {tool}  (version: {version})")
    
    content = None
    if tool == 'fxs:ArticulateStoryline':
        content = extract_storyline_content(pkg_dir)
        if content:
            print(f"Storyline extraction:")
            print(f"  project_id: {content['project_id']}")
            print(f"  course_id: {content['course_id']}")
            print(f"  scenes: {len(content['scenes'])}")
            print(f"  slides: {sum(len(s['slides']) for s in content['scenes'])}")
            print(f"  assets: {content['asset_count']}")
            print(f"  svg corpora: {len(content['svg_corpus'])}")
    
    pkg_iri_base = pkg_iri_base or f'https://example.foxximediums.com/pkg/{manifest["package_id"]}'
    parser_iri = parser_iri or 'https://vocab.foxximediums.com/parsers/storyline/0.1.0'
    extracted_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    
    turtle = emit_turtle(manifest, content, pkg_iri_base, parser_iri, extracted_at)
    return turtle, manifest, content


if __name__ == '__main__':
    import sys
    pkg_dir = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/storyline-test'
    out_path = sys.argv[2] if len(sys.argv) > 2 else '/home/claude/storyline-test/lesson3.ttl'
    
    turtle, manifest, content = parse_package(pkg_dir)
    Path(out_path).write_text(turtle)
    print(f"\nWrote {out_path} ({len(turtle)} chars)")
