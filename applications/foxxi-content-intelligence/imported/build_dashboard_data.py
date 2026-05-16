"""
Convert the parsed RDF graph into a JSON structure optimized for the
dashboard / chat interface.

Output structure:
{
    package: { title, id, standard, authoring_tool, version },
    scenes: [
        { id, title, scene_number, slides: [...] },
        ...
    ],
    slides: [
        {
            id, title, scene_id, sequence_index,
            transcript_segments: [ { audio_id, duration, text, segments: [...] } ],
            transcript_combined: "...",
            concepts: [concept_id, ...],
            alt_text_corpus: "...",
        },
        ...
    ],
    concepts: [
        { id, label, confidence, taught_in_slides: [slide_id, ...], total_freq },
        ...
    ],
    prereq_edges: [
        { from: concept_id, to: concept_id },
        ...
    ],
}
"""

import json
import sys
from pathlib import Path
from rdflib import Graph
from rdflib.namespace import Namespace, RDF, RDFS

sys.path.insert(0, str(Path(__file__).parent))
from foxxi_storyline_parser_v02 import parse_package_v2, slugify


def build_dashboard_data(pkg_dir: str, transcripts_path: str, ttl_path: str = None):
    # Re-run parsing to get all in-memory objects
    turtle, stats, manifest, content, concepts, slide_concepts, prereq_edges, transcripts = parse_package_v2(
        pkg_dir,
        transcripts_path=transcripts_path,
        run_whisper=False,
    )
    
    if ttl_path:
        Path(ttl_path).write_text(turtle)
    
    # Build slide order map
    slide_to_scene = {}
    slide_order_idx = {}
    for scene in content['scenes']:
        for idx, slide in enumerate(scene['slides']):
            slide_to_scene[slide['id']] = scene['id']
            slide_order_idx[slide['id']] = (scene['id'], idx)
    
    # Concepts -> slides reverse map (already in concepts dict)
    
    # Build output
    data = {
        'package': {
            'id': manifest['package_id'],
            'title': manifest['organizations'][0]['title'],
            'standard': manifest['standard'],
            'authoring_tool': 'Articulate Storyline',
            'authoring_version': content.get('authoring_version'),
            'parser_version': '0.2.0',
        },
        'stats': stats,
        'scenes': [],
        'slides': [],
        'concepts': [],
        'prereq_edges': [],
    }
    
    # Scenes
    for scene in content['scenes']:
        data['scenes'].append({
            'id': scene['id'],
            'title': f'Scene {scene["scene_number"]}',
            'scene_number': scene['scene_number'],
            'slide_ids': [s['id'] for s in scene['slides']],
        })
    
    # Slides with full transcripts
    for scene in content['scenes']:
        for idx, slide in enumerate(scene['slides']):
            transcript_segments = []
            transcript_combined = []
            for au in slide['audio_urls']:
                if au in transcripts:
                    t = transcripts[au]
                    transcript_segments.append({
                        'audio_url': au,
                        'duration': t['duration'],
                        'text': t['text'],
                        'segments': t.get('segments', []),
                    })
                    transcript_combined.append(t['text'])
            
            slide_concept_ids = [
                slugify(c) for c in slide_concepts.get(slide['id'], [])
                if slugify(c)
            ]
            
            data['slides'].append({
                'id': slide['id'],
                'title': slide['title'].strip(),
                'scene_id': scene['id'],
                'sequence_index': idx,
                'lms_id': slide.get('lms_id'),
                'audio_count': len(slide['audio_urls']),
                'transcript_segments': transcript_segments,
                'transcript_combined': ' '.join(transcript_combined),
                'concept_ids': slide_concept_ids,
                'alt_text_corpus': '; '.join(set(
                    t for t in slide['alt_text_corpus']
                    if t and t != 'Image 41.emf'
                ))[:500],
            })
    
    # Concepts
    for phrase, info in concepts.items():
        cid = slugify(phrase)
        if not cid:
            continue
        data['concepts'].append({
            'id': cid,
            'label': phrase,
            'confidence': info['confidence'],
            'tier': info.get('tier', 3),
            'taught_in_slides': info['slide_ids'],
            'total_freq': info['total_freq'],
        })
    
    # Prerequisite edges (use concept IDs)
    for from_phrase, to_phrase, conf in prereq_edges:
        from_id = slugify(from_phrase)
        to_id = slugify(to_phrase)
        if not (from_id and to_id):
            continue
        # Only include if both concepts survived to the keep set
        kept_ids = {c['id'] for c in data['concepts']}
        if from_id in kept_ids and to_id in kept_ids:
            data['prereq_edges'].append({
                'from': from_id,
                'to': to_id,
                'confidence': conf,
            })
    
    return data


if __name__ == '__main__':
    pkg_dir = '/home/claude/storyline-test'
    transcripts = '/home/claude/storyline-test/transcripts.json'
    ttl_out = '/home/claude/storyline-test/lesson3_v02.ttl'
    json_out = '/home/claude/storyline-test/dashboard_data.json'
    
    data = build_dashboard_data(pkg_dir, transcripts, ttl_out)
    
    Path(json_out).write_text(json.dumps(data, indent=2))
    
    # Stats
    print(f"\nWrote {json_out}")
    print(f"  Slides: {len(data['slides'])}")
    print(f"  Concepts: {len(data['concepts'])}")
    print(f"  Prereq edges: {len(data['prereq_edges'])}")
    print(f"  Total transcript chars: {sum(len(s['transcript_combined']) for s in data['slides'])}")
    print(f"  JSON size: {Path(json_out).stat().st_size:,} bytes")
