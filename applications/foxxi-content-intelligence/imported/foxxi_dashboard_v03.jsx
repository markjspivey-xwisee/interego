import React, { useState, useEffect, useMemo, useRef } from 'react';

// ════════════════════════════════════════════════════════════════
// COURSE GRAPH DATA — Federation-aware payload.
//
// `DATA.primary` is the course this dashboard is rendered for.
// `DATA.federation[]` are peer courses (in production: discovered via
// Context Graphs `discover_context` against the user's Solid pod;
// here: bundled at build time from the same pod).
//
// Both courses use vocab v0.2.0 prefixes (fxs:, fxk:, fxa:) so cross-
// course concept lookup is structural — same predicate names, same
// IRIs format, just different package IRI bases.
// ════════════════════════════════════════════════════════════════
const RAW_DATA = `{"primary": {"package": {"id": "_69JeglEuzyv", "title": "Lesson 3: Inverter Controls", "standard": "SCORM_2004_4", "authoring_tool": "Articulate Storyline", "authoring_version": "3.104.35448.0", "parser_version": "0.3.0", "vocab_version": "0.2.0", "course_id": "lesson3", "course_label": "Lesson 3", "federation_iri_base": "https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/courses/lesson3"}, "stats": {"manifest_items": 1, "manifest_resources": 1, "scenes": 2, "slides": 12, "audio_files": 22, "transcripts": 22, "audio_seconds": 604.7871250000001, "concepts_total": 92, "concepts_free_standing": 84, "modifier_pairs": 28, "prereq_edges": 130}, "scenes": [{"id": "6RdIHQ8sw43", "title": "Scene 1", "scene_number": 1, "slide_ids": ["5mxvVHmgKIk", "6ps7ro4Er5o", "5zBRyvxOwou", "6eVptVTR2Lx", "5q1PTTjK3aS", "6KhIqryeG83", "6cuGuY88hng", "6JZsAHMHpvb", "66RtiTQPuzj", "5XHGBaZwOfD"]}, {"id": "5sFB072XEDS", "title": "Scene 2", "scene_number": 2, "slide_ids": ["6DAYZylYZ4Y", "6IcYxMXh0mW"]}], "slides": [{"id": "5mxvVHmgKIk", "title": "Welcome", "scene_id": "6RdIHQ8sw43", "sequence_index": 0, "lms_id": "Slide1", "audio_count": 0, "transcript_segments": [], "transcript_combined": "", "concept_ids": [], "alt_text_corpus": "Lesson 3: Inverter Controls; title.jpg; Use this title layout.\\\\nIt is ok to change the background image as long as the EPRI gradient overlay remains on this page prominently displayed.\\\\nRemove audio track if the course does not contain any other audio. You may replace with different audio, especially if you are branding a series of courses. \\\\nAdd prerequisite or recommended prior course work or knowledge to this slide if needed.\\\\n\\\\nStart Course \\u2013 Trigger to jump to About This Course.\\\\n; \\u00a9 2025 E"}, {"id": "6ps7ro4Er5o", "title": "Introduction", "scene_id": "6RdIHQ8sw43", "sequence_index": 1, "lms_id": "Slide2", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/6XoiU1qYPis_44100_48_0.mp3", "duration": 28.578, "text": "It's important for transmission operations personnel to understand how IBR's synchronize to the grid and manage current voltage and power flows. IBR's use advanced electronics to control how they interact with the grid. In the last lesson, we focused on how to produce the desired voltage given a reference voltage. In this lesson, we'll focus on how the control system for the inverter produces the desired voltage set point based on the commands from the base level controller.", "segments": [{"start": 0.0, "end": 5.5, "text": " It's important for transmission operations personnel to understand how IBR's synchronize"}, {"start": 5.5, "end": 9.02, "text": " to the grid and manage current voltage and power flows."}, {"start": 9.02, "end": 13.8, "text": " IBR's use advanced electronics to control how they interact with the grid."}, {"start": 13.8, "end": 18.22, "text": " In the last lesson, we focused on how to produce the desired voltage given a reference"}, {"start": 18.22, "end": 19.3, "text": " voltage."}, {"start": 19.3, "end": 24.060000000000002, "text": " In this lesson, we'll focus on how the control system for the inverter produces the desired"}, {"start": 24.060000000000002, "end": 28.060000000000002, "text": " voltage set point based on the commands from the base level controller."}]}, {"audio_url": "story_content/5dLzuRNCmmT_44100_48_0.mp3", "duration": 9.6391875, "text": "Upon completion of this lesson, you should be able to describe key aspects of the various IBR control system options and be able to meet the learning objectives shown.", "segments": [{"start": 0.0, "end": 5.04, "text": " Upon completion of this lesson, you should be able to describe key aspects of the various"}, {"start": 5.04, "end": 9.24, "text": " IBR control system options and be able to meet the learning objectives shown."}]}], "transcript_combined": "It's important for transmission operations personnel to understand how IBR's synchronize to the grid and manage current voltage and power flows. IBR's use advanced electronics to control how they interact with the grid. In the last lesson, we focused on how to produce the desired voltage given a reference voltage. In this lesson, we'll focus on how the control system for the inverter produces the desired voltage set point based on the commands from the base level controller. Upon completion of this lesson, you should be able to describe key aspects of the various IBR control system options and be able to meet the learning objectives shown.", "concept_ids": ["voltage", "desired-voltage", "grid", "system", "important-for-transmission", "transmission-operations-personnel", "grid-and-manage", "manage-current-voltage", "power-and-voltage", "power-flows-ibr", "how-they-interact", "produce-the-desired", "produces-the-desired", "desired-voltage-set", "set-point-based", "from-the-base", "base-level-controller", "level-controller-upon"], "alt_text_corpus": "Rectangle 2; Lesson 2 Focus; Lesson 3 Focus; Image 37.emf; Rectangle 1"}, {"id": "5zBRyvxOwou", "title": "Inverter Operating Principles", "scene_id": "6RdIHQ8sw43", "sequence_index": 2, "lms_id": "Slide3", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/6qbFcOmxbpl_44100_48_0.mp3", "duration": 17.00575, "text": "To begin, let's review a few foundational inverter operating principles. A present day inverter connects to a network grid. The inverter and the network are different technologies, but the inverter control must follow the grid voltage, so that the inverter and grid are synchronized.", "segments": [{"start": 0.0, "end": 5.0, "text": " To begin, let's review a few foundational inverter operating principles."}, {"start": 5.0, "end": 8.0, "text": " A present day inverter connects to a network grid."}, {"start": 8.0, "end": 11.0, "text": " The inverter and the network are different technologies,"}, {"start": 11.0, "end": 14.0, "text": " but the inverter control must follow the grid voltage,"}, {"start": 14.0, "end": 17.0, "text": " so that the inverter and grid are synchronized."}]}, {"audio_url": "story_content/5pUWbRqZNS6_44100_48_0.mp3", "duration": 45.035125, "text": "As discussed in lesson two, the plant controller provides the set points for active and reactive power. The inverter must quickly and accurately estimate the frequency and the phase angle of grid voltage. This is achieved using a phase-locked loop or PLL. In addition, when the grid voltage changes, the inverter control needs to respond quickly to that change, accurately controlling its terminal current to generate the voltage reference. Simply put, the current injected by the inverter, determined by complex power divided by voltage, needs to match the current drawn by the network, voltage divided by impedance, to maintain the stable grid operation. Click each equation at the bottom of the page for additional information. Click next to continue.", "segments": [{"start": 0.0, "end": 6.5, "text": " As discussed in lesson two, the plant controller provides the set points for active and reactive power."}, {"start": 6.5, "end": 12.0, "text": " The inverter must quickly and accurately estimate the frequency and the phase angle of grid voltage."}, {"start": 12.0, "end": 16.0, "text": " This is achieved using a phase-locked loop or PLL."}, {"start": 16.0, "end": 22.0, "text": " In addition, when the grid voltage changes, the inverter control needs to respond quickly to that change,"}, {"start": 22.0, "end": 26.0, "text": " accurately controlling its terminal current to generate the voltage reference."}, {"start": 26.0, "end": 32.0, "text": " Simply put, the current injected by the inverter, determined by complex power divided by voltage,"}, {"start": 32.0, "end": 39.0, "text": " needs to match the current drawn by the network, voltage divided by impedance, to maintain the stable grid operation."}, {"start": 39.0, "end": 43.0, "text": " Click each equation at the bottom of the page for additional information."}, {"start": 43.0, "end": 45.0, "text": " Click next to continue."}]}], "transcript_combined": "To begin, let's review a few foundational inverter operating principles. A present day inverter connects to a network grid. The inverter and the network are different technologies, but the inverter control must follow the grid voltage, so that the inverter and grid are synchronized. As discussed in lesson two, the plant controller provides the set points for active and reactive power. The inverter must quickly and accurately estimate the frequency and the phase angle of grid voltage. This is achieved using a phase-locked loop or PLL. In addition, when the grid voltage changes, the inverter control needs to respond quickly to that change, accurately controlling its terminal current to generate the voltage reference. Simply put, the current injected by the inverter, determined by complex power divided by voltage, needs to match the current drawn by the network, voltage divided by impedance, to maintain the stable grid operation. Click each equation at the bottom of the page for additional information. Click next to continue.", "concept_ids": ["inverter", "grid", "voltage", "grid-voltage", "inverter-operating-principles", "current", "power", "foundational-inverter-operating", "present-day-inverter", "day-inverter-connects", "grid-the-inverter", "follow-the-grid", "inverter-and-grid", "grid-are-synchronized", "plant-controller-provides", "provides-the-set"], "alt_text_corpus": "Down Arrow 1; Rectangle 5; Rectangle 3; Rectangle 2; Rectangle 1; Rectangle 13; Down Arrow 2; Click each equation to see what it represents; Rectangle 4; Rectangle 12"}, {"id": "6eVptVTR2Lx", "title": "Current Control Overview", "scene_id": "6RdIHQ8sw43", "sequence_index": 3, "lms_id": "Slide4", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/68UQ9jgrgX0_44100_48_0.mp3", "duration": 15.51675, "text": "The objective of Inverter Control is to control the output current of the inverter by using the measured and transformed current and measured and transformed voltage as inputs. The output is the voltage reference or modulating signal for the PWM scheme.", "segments": [{"start": 0.0, "end": 10.0, "text": " The objective of Inverter Control is to control the output current of the inverter by using the measured and transformed current and measured and transformed voltage as inputs."}, {"start": 10.0, "end": 15.0, "text": " The output is the voltage reference or modulating signal for the PWM scheme."}]}, {"audio_url": "story_content/6llp0vzR9dL_44100_48_0.mp3", "duration": 28.8130625, "text": "The inverter control achieves the subjective through a nested loop structure. You learned about this flow in lesson 2, but let's review. The plant controller provides the desired active and reactive power set points to the inverter control. Sensors measure the voltage. The outer loop provides the reference currents which the inner loop uses to generate the reference voltage. This voltage reference is processed by the PWM scheme to generate the system reference voltage E.", "segments": [{"start": 0.0, "end": 4.76, "text": " The inverter control achieves the subjective through a nested loop structure."}, {"start": 4.76, "end": 8.2, "text": " You learned about this flow in lesson 2, but let's review."}, {"start": 8.2, "end": 13.24, "text": " The plant controller provides the desired active and reactive power set points to the inverter"}, {"start": 13.24, "end": 14.24, "text": " control."}, {"start": 14.24, "end": 16.2, "text": " Sensors measure the voltage."}, {"start": 16.2, "end": 20.32, "text": " The outer loop provides the reference currents which the inner loop uses to generate"}, {"start": 20.32, "end": 22.0, "text": " the reference voltage."}, {"start": 22.0, "end": 27.68, "text": " This voltage reference is processed by the PWM scheme to generate the system reference voltage"}, {"start": 27.68, "end": 28.0, "text": " E."}]}], "transcript_combined": "The objective of Inverter Control is to control the output current of the inverter by using the measured and transformed current and measured and transformed voltage as inputs. The output is the voltage reference or modulating signal for the PWM scheme. The inverter control achieves the subjective through a nested loop structure. You learned about this flow in lesson 2, but let's review. The plant controller provides the desired active and reactive power set points to the inverter control. Sensors measure the voltage. The outer loop provides the reference currents which the inner loop uses to generate the reference voltage. This voltage reference is processed by the PWM scheme to generate the system reference voltage E.", "concept_ids": ["voltage", "inverter", "measured-and-transformed", "pwm-scheme", "current", "loop", "output", "current-and-measured", "inputs-the-output", "scheme-the-inverter", "inverter-control-achieves", "achieves-the-subjective", "nested-loop-structure", "structure-you-learned", "2-but-let", "plant-controller-provides", "provides-the-desired", "active-and-reactive"], "alt_text_corpus": "Up Arrow 1; Up Arrow 2; Rectangle 3; Rectangle 2; Using measured and transformed current, i; Control output current of the inverter:; Inverter Control Objective; Rectangle 4; Image 38.emf; Inverter Control Objective\\\\nControl output current of the inverter: \\\\nUsing measured and transformed current, i\\\\nUsing measured and transformed voltage, Vt; Rectangle 1; Using measured and transformed voltage, Vt"}, {"id": "5q1PTTjK3aS", "title": "Power and Voltage Control Overview", "scene_id": "6RdIHQ8sw43", "sequence_index": 4, "lms_id": "Slide5", "audio_count": 1, "transcript_segments": [{"audio_url": "story_content/5x2cQjOSedu_44100_48_0.mp3", "duration": 21.0285625, "text": "Now that we've discussed current control, let's discuss power and voltage control. Power control is dependent on the primary power source. The inverter controls DC voltage while terminal voltage depends on both the inverter and how the system is reacting to it. Click next to look in more depth at active and reactive power control.", "segments": [{"start": 0.0, "end": 5.6000000000000005, "text": " Now that we've discussed current control, let's discuss power and voltage control."}, {"start": 5.6000000000000005, "end": 9.24, "text": " Power control is dependent on the primary power source."}, {"start": 9.24, "end": 14.44, "text": " The inverter controls DC voltage while terminal voltage depends on both the inverter and"}, {"start": 14.44, "end": 16.8, "text": " how the system is reacting to it."}, {"start": 16.8, "end": 20.44, "text": " Click next to look in more depth at active and reactive power control."}]}], "transcript_combined": "Now that we've discussed current control, let's discuss power and voltage control. Power control is dependent on the primary power source. The inverter controls DC voltage while terminal voltage depends on both the inverter and how the system is reacting to it. Click next to look in more depth at active and reactive power control.", "concept_ids": ["power", "voltage", "power-and-voltage", "inverter", "current-control-let", "voltage-control-power", "primary-power-source", "source-the-inverter", "voltage-while-terminal", "terminal-voltage-depends", "inverter-and-how", "how-the-system", "active-and-reactive", "discussed-current", "reactive-power"], "alt_text_corpus": "Rectangle 5; Rectangle 6; Voltage Control; Rectangle 3; Rectangle 2; Power Control; Rectangle 4; Rectangle 1"}, {"id": "6KhIqryeG83", "title": "Active and Reactive Power Control", "scene_id": "6RdIHQ8sw43", "sequence_index": 5, "lms_id": "Slide6", "audio_count": 3, "transcript_segments": [{"audio_url": "story_content/6Uhqd0AwLft_44100_48_0.mp3", "duration": 36.258, "text": "There are two common approaches for managing DC voltage so that the inverter's output voltage is synchronized with the grid. In one approach, the primary power source controls active power while the inverter regulates DC voltage. In the other approach, the source controls DC voltage and the inverter manages active power. We'll focus on the first approach. This approach is used, for example, in a maximum PPS tracking scheme where the maximum power is extracted from the primary power source. Click each button to learn how active and reactive power control systems are implemented.", "segments": [{"start": 0.0, "end": 5.76, "text": " There are two common approaches for managing DC voltage so that the inverter's output voltage"}, {"start": 5.76, "end": 8.040000000000001, "text": " is synchronized with the grid."}, {"start": 8.040000000000001, "end": 12.68, "text": " In one approach, the primary power source controls active power while the inverter regulates"}, {"start": 12.68, "end": 14.48, "text": " DC voltage."}, {"start": 14.48, "end": 19.12, "text": " In the other approach, the source controls DC voltage and the inverter manages active"}, {"start": 19.12, "end": 20.12, "text": " power."}, {"start": 20.12, "end": 22.28, "text": " We'll focus on the first approach."}, {"start": 22.28, "end": 27.080000000000002, "text": " This approach is used, for example, in a maximum PPS tracking scheme where the maximum"}, {"start": 27.080000000000002, "end": 30.720000000000002, "text": " power is extracted from the primary power source."}, {"start": 30.720000000000002, "end": 35.24, "text": " Click each button to learn how active and reactive power control systems are implemented."}]}, {"audio_url": "story_content/5gtwDF7sBFF_44100_48_0.mp3", "duration": 27.4285625, "text": "Reactive power can be controlled in open loop or closed loop. With open loop control, the reference set point for reactive current is determined based on the reactive power set point and the voltage measurement. So Q, reactive power divided by Vd, voltage gives the reactive reference current. With closed loop control, the reference reactive power is compared to the measured reactive power and then a compensator generates the reactive reference current.", "segments": [{"start": 0.0, "end": 4.6000000000000005, "text": " Reactive power can be controlled in open loop or closed loop."}, {"start": 4.6000000000000005, "end": 8.68, "text": " With open loop control, the reference set point for reactive current is determined based"}, {"start": 8.68, "end": 12.24, "text": " on the reactive power set point and the voltage measurement."}, {"start": 12.24, "end": 18.76, "text": " So Q, reactive power divided by Vd, voltage gives the reactive reference current."}, {"start": 18.76, "end": 22.64, "text": " With closed loop control, the reference reactive power is compared to the measured"}, {"start": 22.64, "end": 26.64, "text": " reactive power and then a compensator generates the reactive reference current."}]}, {"audio_url": "story_content/6Rv8igKXCV7_44100_48_0.mp3", "duration": 46.053875, "text": "Let's examine two DC control approaches used to determine the amount of active power. In the first approach, control is based on DC-voltage squared control, where VDC squared control develops an active power reference. This reference can then be used for either closed loop active power control or open loop control by calculating a current reference. This approach is more commonly used in bulk renewable generation inverters and more accurately produces controllable power output. The second DC voltage control approach controls VDC directly by developing the current reference to maintain the desired voltage level. This approach is more easily used in distribution-connected distributed energy resources or DER.", "segments": [{"start": 0.0, "end": 6.6000000000000005, "text": " Let's examine two DC control approaches used to determine the amount of active power."}, {"start": 6.6000000000000005, "end": 12.24, "text": " In the first approach, control is based on DC-voltage squared control, where VDC squared"}, {"start": 12.24, "end": 15.44, "text": " control develops an active power reference."}, {"start": 15.44, "end": 19.88, "text": " This reference can then be used for either closed loop active power control or open"}, {"start": 19.88, "end": 23.2, "text": " loop control by calculating a current reference."}, {"start": 23.2, "end": 28.12, "text": " This approach is more commonly used in bulk renewable generation inverters and more accurately"}, {"start": 28.12, "end": 31.0, "text": " produces controllable power output."}, {"start": 31.0, "end": 36.160000000000004, "text": " The second DC voltage control approach controls VDC directly by developing the current"}, {"start": 36.160000000000004, "end": 39.32, "text": " reference to maintain the desired voltage level."}, {"start": 39.32, "end": 44.28, "text": " This approach is more easily used in distribution-connected distributed energy resources"}, {"start": 44.28, "end": 45.24, "text": " or DER."}]}], "transcript_combined": "There are two common approaches for managing DC voltage so that the inverter's output voltage is synchronized with the grid. In one approach, the primary power source controls active power while the inverter regulates DC voltage. In the other approach, the source controls DC voltage and the inverter manages active power. We'll focus on the first approach. This approach is used, for example, in a maximum PPS tracking scheme where the maximum power is extracted from the primary power source. Click each button to learn how active and reactive power control systems are implemented. Reactive power can be controlled in open loop or closed loop. With open loop control, the reference set point for reactive current is determined based on the reactive power set point and the voltage measurement. So Q, reactive power divided by Vd, voltage gives the reactive reference current. With closed loop control, the reference reactive power is compared to the measured reactive power and then a compensator generates the reactive reference current. Let's examine two DC control approaches used to determine the amount of active power. In the first approach, control is based on DC-voltage squared control, where VDC squared control develops an active power reference. This reference can then be used for either closed loop active power control or open loop control by calculating a current reference. This approach is more commonly used in bulk renewable generation inverters and more accurately produces controllable power output. The second DC voltage control approach controls VDC directly by developing the current reference to maintain the desired voltage level. This approach is more easily used in distribution-connected distributed energy resources or DER.", "concept_ids": ["power", "reactive-power", "voltage", "active-power", "loop", "current", "closed-loop", "active-and-reactive", "primary-power-source", "reactive-reference-current", "inverter", "output", "approaches-for-managing"], "alt_text_corpus": "Rectangle 6; Approach 1:  Primary power source (PPS) controls active power and the inverter controls Vdc.\\\\nApproach 2:  PPS controls dc voltage and the inverter manages active power.  ; Rectangle 11; Image 45.emf; Reactive Power; Rectangle 8; Rectangle 10; Rectangle 5; Image 42.emf; Active Power; Image 43.emf; More commonly used in bulk renewable generation inverters; more accurately produces controllable power output.; Image 44.emf; Approach 1:  Primary power source (PPS) controls active power "}, {"id": "6cuGuY88hng", "title": "Voltage Control", "scene_id": "6RdIHQ8sw43", "sequence_index": 6, "lms_id": "Slide7", "audio_count": 6, "transcript_segments": [{"audio_url": "story_content/6JiqSURUYvI_44100_48_0.mp3", "duration": 15.177125, "text": "As you learned earlier, terminal voltage is dependent on both the inverter and how the system is reacting to it. We assume that the inverter autonomously measures and regulates terminal voltage locally without receiving a voltage reference point from the plant controller.", "segments": [{"start": 0.0, "end": 7.0, "text": " As you learned earlier, terminal voltage is dependent on both the inverter and how the system is reacting to it."}, {"start": 7.0, "end": 15.0, "text": " We assume that the inverter autonomously measures and regulates terminal voltage locally without receiving a voltage reference point from the plant controller."}]}, {"audio_url": "story_content/5ZIVqtC2X4g_44100_48_0.mp3", "duration": 39.915125, "text": "Inverter voltage is controlled through reactive current. To understand how the inverter develops the reactive current reference in the dynamics, we can use Kirchhoff's voltage law to calculate the system voltage, VTD1. The equation shows that the active current component of the terminal voltage depends on several terms. Note that the parameter LG which represents the grid inductance and is an indication of the short circuit strength of the grid appears in two of those terms. This suggests that the dynamics of VTD1 depends on grid strength. Click each component of the equation that contributes to system voltage to learn more. Click next to continue.", "segments": [{"start": 0.0, "end": 3.6, "text": " Inverter voltage is controlled through reactive current."}, {"start": 3.6, "end": 8.0, "text": " To understand how the inverter develops the reactive current reference in the dynamics,"}, {"start": 8.0, "end": 13.5, "text": " we can use Kirchhoff's voltage law to calculate the system voltage, VTD1."}, {"start": 13.5, "end": 17.8, "text": " The equation shows that the active current component of the terminal voltage depends on"}, {"start": 17.8, "end": 19.3, "text": " several terms."}, {"start": 19.3, "end": 24.400000000000002, "text": " Note that the parameter LG which represents the grid inductance and is an indication"}, {"start": 24.400000000000002, "end": 28.7, "text": " of the short circuit strength of the grid appears in two of those terms."}, {"start": 28.7, "end": 33.2, "text": " This suggests that the dynamics of VTD1 depends on grid strength."}, {"start": 33.2, "end": 37.7, "text": " Click each component of the equation that contributes to system voltage to learn more."}, {"start": 37.7, "end": 39.7, "text": " Click next to continue."}]}, {"audio_url": "story_content/6I0VR61PQcO_44100_48_0.mp3", "duration": 49.2408125, "text": "The last term in the equation is system voltage. The presence of the term LG in voltage dynamics makes voltage control dependent on grid strength. The graph shows the step response of the terminal voltage for different grid short circuit ratio or SCR values with the same controller gain. In weaker grid conditions, for example, a short circuit ratio of 2 to 5, the response is faster. However, as the grid gets stronger, for example, a short circuit ratio of 10 to 15, the response slows down because LG is larger and it takes more reactive current to change voltage. In summary, the IBR response is dependent upon both its internal control system and the grid strength at its connection point. The graph of the voltage response at different SCR values is extremely telling.", "segments": [{"start": 0.0, "end": 3.5, "text": " The last term in the equation is system voltage."}, {"start": 3.5, "end": 6.96, "text": " The presence of the term LG in voltage dynamics makes"}, {"start": 6.96, "end": 9.8, "text": " voltage control dependent on grid strength."}, {"start": 9.8, "end": 13.040000000000001, "text": " The graph shows the step response of the terminal voltage"}, {"start": 13.040000000000001, "end": 16.32, "text": " for different grid short circuit ratio or SCR values"}, {"start": 16.32, "end": 18.3, "text": " with the same controller gain."}, {"start": 18.3, "end": 20.6, "text": " In weaker grid conditions, for example,"}, {"start": 20.6, "end": 24.400000000000002, "text": " a short circuit ratio of 2 to 5, the response is faster."}, {"start": 24.400000000000002, "end": 26.6, "text": " However, as the grid gets stronger,"}, {"start": 26.6, "end": 29.900000000000002, "text": " for example, a short circuit ratio of 10 to 15,"}, {"start": 29.900000000000002, "end": 32.800000000000004, "text": " the response slows down because LG is larger"}, {"start": 32.800000000000004, "end": 36.2, "text": " and it takes more reactive current to change voltage."}, {"start": 36.2, "end": 40.2, "text": " In summary, the IBR response is dependent upon both its internal"}, {"start": 40.2, "end": 43.900000000000006, "text": " control system and the grid strength at its connection point."}, {"start": 43.900000000000006, "end": 47.0, "text": " The graph of the voltage response at different SCR values"}, {"start": 47.0, "end": 49.0, "text": " is extremely telling."}]}, {"audio_url": "story_content/5jMp1uOBvcw_44100_48_0.mp3", "duration": 24.9469375, "text": "LG Omega PLLIQ1 represents a voltage across the system inductance due to the rotating reference frame or changing frequency. LG or grid-side inductance can take on a range of values based on system conditions. In a weak grid where LG is large, a small change in reactive current can cause a large change in voltage. This can affect the controller's performance.", "segments": [{"start": 0.0, "end": 9.0, "text": " LG Omega PLLIQ1 represents a voltage across the system inductance due to the rotating reference frame or changing frequency."}, {"start": 9.0, "end": 15.0, "text": " LG or grid-side inductance can take on a range of values based on system conditions."}, {"start": 15.0, "end": 22.0, "text": " In a weak grid where LG is large, a small change in reactive current can cause a large change in voltage."}, {"start": 22.0, "end": 25.0, "text": " This can affect the controller's performance."}]}, {"audio_url": "story_content/6SypeIXvavu_44100_48_0.mp3", "duration": 24.293875, "text": "This part of the equation represents the voltage drop due to system inductance and the change rate of the active current. In a weak grid, after a fault, we aim to limit the ramp rate of the active current component, DID1, by DT to avoid rapid changes in ID1 that could lead to undesirable large changes in voltage. LG may take on a range of values based on system conditions.", "segments": [{"start": 0.0, "end": 7.0, "text": " This part of the equation represents the voltage drop due to system inductance and the change rate of the active current."}, {"start": 7.0, "end": 12.0, "text": " In a weak grid, after a fault, we aim to limit the ramp rate of the active current component,"}, {"start": 12.0, "end": 20.0, "text": " DID1, by DT to avoid rapid changes in ID1 that could lead to undesirable large changes in voltage."}, {"start": 20.0, "end": 24.0, "text": " LG may take on a range of values based on system conditions."}]}, {"audio_url": "story_content/5nckAIutyat_44100_48_0.mp3", "duration": 43.0236875, "text": "This part of the equation represents voltage drop due to system resistance. Rg is the resistive part of the grid impedance. ID references active power current. In transmission applications, we can assume that the resistive part of grid impedance R is a negligible component of the overall impedance x. Hence, we can ignore Rgid with in voltage dynamics. This suggests that the terminal voltage can be controlled by the reactive current. Looking at the voltage control system, the reference voltage is compared to the measured voltage and the difference is processed by a compensator to develop the reference current. The compensator is typically a proportional integrator controller.", "segments": [{"start": 0.0, "end": 4.96, "text": " This part of the equation represents voltage drop due to system resistance."}, {"start": 4.96, "end": 8.5, "text": " Rg is the resistive part of the grid impedance."}, {"start": 8.5, "end": 11.4, "text": " ID references active power current."}, {"start": 11.4, "end": 16.14, "text": " In transmission applications, we can assume that the resistive part of grid impedance"}, {"start": 16.14, "end": 20.22, "text": " R is a negligible component of the overall impedance x."}, {"start": 20.22, "end": 24.32, "text": " Hence, we can ignore Rgid with in voltage dynamics."}, {"start": 24.32, "end": 28.560000000000002, "text": " This suggests that the terminal voltage can be controlled by the reactive current."}, {"start": 28.8, "end": 33.84, "text": " Looking at the voltage control system, the reference voltage is compared to the measured voltage"}, {"start": 33.84, "end": 38.5, "text": " and the difference is processed by a compensator to develop the reference current."}, {"start": 38.5, "end": 42.36, "text": " The compensator is typically a proportional integrator controller."}]}], "transcript_combined": "As you learned earlier, terminal voltage is dependent on both the inverter and how the system is reacting to it. We assume that the inverter autonomously measures and regulates terminal voltage locally without receiving a voltage reference point from the plant controller. Inverter voltage is controlled through reactive current. To understand how the inverter develops the reactive current reference in the dynamics, we can use Kirchhoff's voltage law to calculate the system voltage, VTD1. The equation shows that the active current component of the terminal voltage depends on several terms. Note that the parameter LG which represents the grid inductance and is an indication of the short circuit strength of the grid appears in two of those terms. This suggests that the dynamics of VTD1 depends on grid strength. Click each component of the equation that contributes to system voltage to learn more. Click next to continue. The last term in the equation is system voltage. The presence of the term LG in voltage dynamics makes voltage control dependent on grid strength. The graph shows the step response of the terminal voltage for different grid short circuit ratio or SCR values with the same controller gain. In weaker grid conditions, for example, a short circuit ratio of 2 to 5, the response is faster. However, as the grid gets stronger, for example, a short circuit ratio of 10 to 15, the response slows down because LG is larger and it takes more reactive current to change voltage. In summary, the IBR response is dependent upon both its internal control system and the grid strength at its connection point. The graph of the voltage response at different SCR values is extremely telling. LG Omega PLLIQ1 represents a voltage across the system inductance due to the rotating reference frame or changing frequency. LG or grid-side inductance can take on a range of values based on system conditions. In a weak grid where LG is large, a small change in reactive current can cause a large change in voltage. This can affect the controller's performance. This part of the equation represents the voltage drop due to system inductance and the change rate of the active current. In a weak grid, after a fault, we aim to limit the ramp rate of the active current component, DID1, by DT to avoid rapid changes in ID1 that could lead to undesirable large changes in voltage. LG may take on a range of values based on system conditions. This part of the equation represents voltage drop due to system resistance. Rg is the resistive part of the grid impedance. ID references active power current. In transmission applications, we can assume that the resistive part of grid impedance R is a negligible component of the overall impedance x. Hence, we can ignore Rgid with in voltage dynamics. This suggests that the terminal voltage can be controlled by the reactive current. Looking at the voltage control system, the reference voltage is compared to the measured voltage and the difference is processed by a compensator to develop the reference current. The compensator is typically a proportional integrator controller.", "concept_ids": ["voltage", "grid", "system", "current", "terminal-voltage", "reactive-current", "short-circuit", "short-circuit-ratio", "response", "system-voltage", "active-current", "grid-strength", "inverter"], "alt_text_corpus": "IBR Internal control system; IBR response is dependent on:\\\\nIBR Internal control system\\\\nGrid strength at connection point; Rectangle 6; Note:  Lg may take on a range of values based on system conditions.; Rectangle 8; IBR response is dependent on:; Control terminal voltage (Vtd1) controlled by reactive current (iq1); Required to account for voltage drops due to changing frequency.; Rectangle 5; Required to account for voltage drops due to changing frequency. \\\\nNote:  Lg may take on a range of v"}, {"id": "6JZsAHMHpvb", "title": "Fault Ride-Through Response (FRT)", "scene_id": "6RdIHQ8sw43", "sequence_index": 7, "lms_id": "Slide8", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/64w1SoQq2BD_44100_48_0.mp3", "duration": 33.43675, "text": "So far we've discussed control under normal operating conditions where voltage and frequency are within the normal range and the plant controller generates set points for individual inverters. What do control objectives look like during abnormal conditions such as a fault where the voltage is fallen outside the normal range? When grid voltage is abnormally low or high, the inverter operates in low voltage drive through or high voltage drive through control mode. The plant controls are typically frozen and the inverter control responds to its terminal voltage.", "segments": [{"start": 0.0, "end": 5.6000000000000005, "text": " So far we've discussed control under normal operating conditions where voltage and frequency"}, {"start": 5.6000000000000005, "end": 10.08, "text": " are within the normal range and the plant controller generates set points for individual"}, {"start": 10.08, "end": 11.64, "text": " inverters."}, {"start": 11.64, "end": 16.0, "text": " What do control objectives look like during abnormal conditions such as a fault where the"}, {"start": 16.0, "end": 19.48, "text": " voltage is fallen outside the normal range?"}, {"start": 19.48, "end": 24.48, "text": " When grid voltage is abnormally low or high, the inverter operates in low voltage"}, {"start": 24.48, "end": 27.76, "text": " drive through or high voltage drive through control mode."}, {"start": 27.76, "end": 32.24, "text": " The plant controls are typically frozen and the inverter control responds to its terminal"}, {"start": 32.24, "end": 32.84, "text": " voltage."}]}, {"audio_url": "story_content/6O98E7I3oiU_44100_48_0.mp3", "duration": 9.247375, "text": "Click on each photo to learn about some control objectives for a fault ride through response. Click next when you have finished to continue to a lesson summary.", "segments": [{"start": 0.0, "end": 5.0, "text": " Click on each photo to learn about some control objectives for a fault ride through response."}, {"start": 5.0, "end": 9.0, "text": " Click next when you have finished to continue to a lesson summary."}]}], "transcript_combined": "So far we've discussed control under normal operating conditions where voltage and frequency are within the normal range and the plant controller generates set points for individual inverters. What do control objectives look like during abnormal conditions such as a fault where the voltage is fallen outside the normal range? When grid voltage is abnormally low or high, the inverter operates in low voltage drive through or high voltage drive through control mode. The plant controls are typically frozen and the inverter control responds to its terminal voltage. Click on each photo to learn about some control objectives for a fault ride through response. Click next when you have finished to continue to a lesson summary.", "concept_ids": ["voltage", "normal-range", "voltage-drive", "response", "inverter", "fault-ride-through-response", "ride-through-response-frt", "normal-operating-conditions", "conditions-where-voltage", "voltage-and-frequency", "plant-controller-generates", "controller-generates-set", "generates-set-points", "points-for-individual", "individual-inverters-what"], "alt_text_corpus": "Maintain current limits of the power electronics \\\\nControl dc voltage\\\\nInject reactive current to keep phase current between 1.1 - 1.5; Rectangle 2; Inject reactive current to support the voltage - either positive or negative sequence; Rectangle 4; Image 38.emf; Control Objectives; Have fast response time - tens of milliseconds -- based on the agreed code and interconnection requirements; Rectangle 1"}, {"id": "66RtiTQPuzj", "title": "Conclusion", "scene_id": "6RdIHQ8sw43", "sequence_index": 8, "lms_id": "Slide9", "audio_count": 3, "transcript_segments": [{"audio_url": "story_content/5jKG5HVuxEz_44100_48_0.mp3", "duration": 6.373875, "text": "You have now completed the third lesson of the Inverter-based Resource Basics and Operations course.", "segments": [{"start": 0.0, "end": 6.0, "text": " You have now completed the third lesson of the Inverter-based Resource Basics and Operations course."}]}, {"audio_url": "story_content/6Yj2OVM5BXp_44100_48_0.mp3", "duration": 16.58775, "text": "In this lesson, you reviewed some basic inverter operating principles. You were introduced to control objectives used in normal conditions for current, outer loop, reactive power and voltage controls. You also reviewed some control objectives for a fault ride-through response.", "segments": [{"start": 0.0, "end": 5.0, "text": " In this lesson, you reviewed some basic inverter operating principles."}, {"start": 5.0, "end": 9.8, "text": " You were introduced to control objectives used in normal conditions for current, outer loop,"}, {"start": 9.8, "end": 12.3, "text": " reactive power and voltage controls."}, {"start": 12.3, "end": 16.0, "text": " You also reviewed some control objectives for a fault ride-through response."}]}, {"audio_url": "story_content/60Wi5ALwlLq_44100_48_0.mp3", "duration": 7.1575625, "text": "You should now be able to describe key aspects of the various IBR control system options covered in this lesson.", "segments": [{"start": 0.0, "end": 7.0, "text": " You should now be able to describe key aspects of the various IBR control system options covered in this lesson."}]}], "transcript_combined": "You have now completed the third lesson of the Inverter-based Resource Basics and Operations course. In this lesson, you reviewed some basic inverter operating principles. You were introduced to control objectives used in normal conditions for current, outer loop, reactive power and voltage controls. You also reviewed some control objectives for a fault ride-through response. You should now be able to describe key aspects of the various IBR control system options covered in this lesson.", "concept_ids": ["inverter-based-resource-basics", "basics-and-operations", "reviewed-some-basic", "basic-inverter-operating", "inverter-operating-principles", "conditions-for-current", "current-outer-loop", "outer-loop-reactive", "loop-reactive-power", "power-and-voltage", "fault-ride-through-response", "ibr-control-system", "system-options-covered", "normal-conditions", "various-ibr"], "alt_text_corpus": "AdobeStock_635174439.jpg; Rectangle 2; You have now completed Lesson 3: Inverter Controls; Image 38.emf; Rectangle 1"}, {"id": "5XHGBaZwOfD", "title": "Thank You", "scene_id": "6RdIHQ8sw43", "sequence_index": 9, "lms_id": "Slide10", "audio_count": 1, "transcript_segments": [{"audio_url": "story_content/5lCm0CvEUym_44100_48_0.mp3", "duration": 60.029375, "text": "Thank you.", "segments": [{"start": 0.0, "end": 19.72, "text": " Thank you."}]}], "transcript_combined": "Thank you.", "concept_ids": [], "alt_text_corpus": "Thank you for your participation in \\\\nLesson 3: Inverter Controls.\\\\n\\\\rSelect the Exit button to end this course.; Exit; EPRI training_editable backgrounds EXIT.jpg; Instructions for Developer:\\\\n\\\\nThis slide must be included in all courses.\\\\nThis slide must contain the course title, the EPRI U graphic, and an Exit button.\\\\nThe background image and other features can be changed to fit each course.\\\\nRemove the music if the course does not contain audio, or change the music if desired."}, {"id": "6DAYZylYZ4Y", "title": "Navigating This Course", "scene_id": "5sFB072XEDS", "sequence_index": 0, "lms_id": "Slide1", "audio_count": 0, "transcript_segments": [], "transcript_combined": "", "concept_ids": [], "alt_text_corpus": "Submit.png; Adjustable Player Settings; Arrow 1; On the playbar, you can switch closed captioning on or off. This can be accomplished by selecting the closed captioning button once for on and a second time for off. \\\\n\\\\nNote: The closed captioning button will not be present if there is no audio or if the audio is not captioned.; CC.png; Close.png; instructions-bg.jpg; Glossary Navigation.png; Full Screen Toggle; Customize your learning experience by selecting the gear icon and changing the adjust"}, {"id": "6IcYxMXh0mW", "title": "About This Course", "scene_id": "5sFB072XEDS", "sequence_index": 1, "lms_id": "Slide2", "audio_count": 0, "transcript_segments": [], "transcript_combined": "", "concept_ids": [], "alt_text_corpus": "Disclaimer; template3.jpg; About EPRI\\\\n\\\\nFounded in 1972, EPRI is the world\\u2019s preeminent independent, non-profit energy research and development organization, with offices around the world. EPRI\\u2019s trusted experts collaborate with more than 450 companies in 45 countries, driving innovation to ensure the public has clean, safe, reliable, affordable, and equitable access to electricity across the globe. Together, we are shaping the future of energy.\\\\n\\\\n; \\\\n\\\\nAcknowledgments\\\\n\\\\nEPRI would like to ac"}], "concepts": [{"id": "inverter", "label": "inverter", "confidence": 0.95, "tier": 1, "is_free_standing": true, "head_word": "inverter", "taught_in_slides": ["5zBRyvxOwou", "6eVptVTR2Lx", "5q1PTTjK3aS", "6KhIqryeG83", "6cuGuY88hng", "6JZsAHMHpvb"], "total_freq": 24}, {"id": "reactive-power", "label": "reactive power", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "power", "taught_in_slides": ["5q1PTTjK3aS", "6KhIqryeG83"], "total_freq": 8}, {"id": "active-and-reactive", "label": "active and reactive", "confidence": 0.93, "tier": 1, "is_free_standing": true, "head_word": "reactive", "taught_in_slides": ["6eVptVTR2Lx", "5q1PTTjK3aS", "6KhIqryeG83"], "total_freq": 4}, {"id": "power-and-voltage", "label": "power and voltage", "confidence": 0.93, "tier": 1, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6ps7ro4Er5o", "5q1PTTjK3aS", "66RtiTQPuzj"], "total_freq": 4}, {"id": "primary-power-source", "label": "primary power source", "confidence": 0.92, "tier": 1, "is_free_standing": true, "head_word": "source", "taught_in_slides": ["5q1PTTjK3aS", "6KhIqryeG83"], "total_freq": 3}, {"id": "inverter-operating-principles", "label": "inverter operating principles", "confidence": 0.92, "tier": 1, "is_free_standing": true, "head_word": "principles", "taught_in_slides": ["5zBRyvxOwou", "66RtiTQPuzj"], "total_freq": 3}, {"id": "plant-controller-provides", "label": "plant controller provides", "confidence": 0.91, "tier": 1, "is_free_standing": true, "head_word": "provides", "taught_in_slides": ["5zBRyvxOwou", "6eVptVTR2Lx"], "total_freq": 2}, {"id": "fault-ride-through-response", "label": "fault ride-through response", "confidence": 0.91, "tier": 1, "is_free_standing": true, "head_word": "response", "taught_in_slides": ["6JZsAHMHpvb", "66RtiTQPuzj"], "total_freq": 2}, {"id": "terminal-voltage", "label": "terminal voltage", "confidence": 0.73, "tier": 2, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6cuGuY88hng"], "total_freq": 5}, {"id": "active-power", "label": "active power", "confidence": 0.73, "tier": 2, "is_free_standing": true, "head_word": "power", "taught_in_slides": ["6KhIqryeG83"], "total_freq": 5}, {"id": "reactive-current", "label": "reactive current", "confidence": 0.73, "tier": 2, "is_free_standing": true, "head_word": "current", "taught_in_slides": ["6cuGuY88hng"], "total_freq": 5}, {"id": "short-circuit", "label": "short circuit", "confidence": 0.72, "tier": 2, "is_free_standing": true, "head_word": "circuit", "taught_in_slides": ["6cuGuY88hng"], "total_freq": 4}, {"id": "grid-strength", "label": "grid strength", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "strength", "taught_in_slides": ["6cuGuY88hng"], "total_freq": 3}, {"id": "active-current", "label": "active current", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "current", "taught_in_slides": ["6cuGuY88hng"], "total_freq": 3}, {"id": "short-circuit-ratio", "label": "short circuit ratio", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "ratio", "taught_in_slides": ["6cuGuY88hng"], "total_freq": 3}, {"id": "closed-loop", "label": "closed loop", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "loop", "taught_in_slides": ["6KhIqryeG83"], "total_freq": 3}, {"id": "grid-voltage", "label": "grid voltage", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 3}, {"id": "system-voltage", "label": "system voltage", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6cuGuY88hng"], "total_freq": 3}, {"id": "voltage-drive", "label": "voltage drive", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "drive", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "pwm-scheme", "label": "pwm scheme", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "scheme", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 2}, {"id": "reactive-reference-current", "label": "reactive reference current", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "current", "taught_in_slides": ["6KhIqryeG83"], "total_freq": 2}, {"id": "desired-voltage", "label": "desired voltage", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 2}, {"id": "measured-and-transformed", "label": "measured and transformed", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "transformed", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 2}, {"id": "normal-range", "label": "normal range", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "range", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "foundational-inverter-operating", "label": "foundational inverter operating", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "operating", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "provides-the-set", "label": "provides the set", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "set", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "how-the-system", "label": "how the system", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "system", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "plant-controller-generates", "label": "plant controller generates", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "generates", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "follow-the-grid", "label": "follow the grid", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "grid", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "various-ibr", "label": "various ibr", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "ibr", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "transmission-operations-personnel", "label": "transmission operations personnel", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "personnel", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "grid-the-inverter", "label": "grid the inverter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "inverter", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "approaches-for-managing", "label": "approaches for managing", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "managing", "taught_in_slides": ["6KhIqryeG83"], "total_freq": 1}, {"id": "system-options-covered", "label": "system options covered", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "covered", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "achieves-the-subjective", "label": "achieves the subjective", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "subjective", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "nested-loop-structure", "label": "nested loop structure", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "structure", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "important-for-transmission", "label": "important for transmission", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "transmission", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "present-day-inverter", "label": "present day inverter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "inverter", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "basics-and-operations", "label": "basics and operations", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "operations", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "voltage-while-terminal", "label": "voltage while terminal", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "terminal", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "voltage-control-power", "label": "voltage control power", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "power", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "discussed-current", "label": "discussed current", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "current", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "inverter-and-grid", "label": "inverter and grid", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "grid", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "2-but-let", "label": "2 but let", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "let", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "conditions-for-current", "label": "conditions for current", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "current", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "structure-you-learned", "label": "structure you learned", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "learned", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "provides-the-desired", "label": "provides the desired", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "desired", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "conditions-where-voltage", "label": "conditions where voltage", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "current-outer-loop", "label": "current outer loop", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "loop", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "desired-voltage-set", "label": "desired voltage set", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "set", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "source-the-inverter", "label": "source the inverter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "inverter", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "current-control-let", "label": "current control let", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "let", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "power-flows-ibr", "label": "power flows ibr", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "ibr", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "inputs-the-output", "label": "inputs the output", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "output", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "terminal-voltage-depends", "label": "terminal voltage depends", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "depends", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "generates-set-points", "label": "generates set points", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "points", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "loop-reactive-power", "label": "loop reactive power", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "power", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "voltage-and-frequency", "label": "voltage and frequency", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "frequency", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "points-for-individual", "label": "points for individual", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "individual", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "set-point-based", "label": "set point based", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "based", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "inverter-and-how", "label": "inverter and how", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "how", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "controller-generates-set", "label": "controller generates set", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "set", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "basic-inverter-operating", "label": "basic inverter operating", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "operating", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "current-and-measured", "label": "current and measured", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "measured", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "ride-through-response-frt", "label": "ride-through response frt", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "frt", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "base-level-controller", "label": "base level controller", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "controller", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "level-controller-upon", "label": "level controller upon", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "upon", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "normal-operating-conditions", "label": "normal operating conditions", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "conditions", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "produce-the-desired", "label": "produce the desired", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "desired", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "how-they-interact", "label": "how they interact", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "interact", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "scheme-the-inverter", "label": "scheme the inverter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "inverter", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "normal-conditions", "label": "normal conditions", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "conditions", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "outer-loop-reactive", "label": "outer loop reactive", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "reactive", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "produces-the-desired", "label": "produces the desired", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "desired", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "individual-inverters-what", "label": "individual inverters what", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "what", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 1}, {"id": "manage-current-voltage", "label": "manage current voltage", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "day-inverter-connects", "label": "day inverter connects", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "connects", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "grid-and-manage", "label": "grid and manage", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "manage", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "grid-are-synchronized", "label": "grid are synchronized", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "synchronized", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "inverter-control-achieves", "label": "inverter control achieves", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "achieves", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "reviewed-some-basic", "label": "reviewed some basic", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "basic", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "from-the-base", "label": "from the base", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "base", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "inverter-based-resource-basics", "label": "inverter-based resource basics", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "basics", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "ibr-control-system", "label": "ibr control system", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "system", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "voltage", "label": "voltage", "confidence": 0.93, "tier": 1, "is_free_standing": false, "head_word": "voltage", "taught_in_slides": ["6ps7ro4Er5o", "5zBRyvxOwou", "6eVptVTR2Lx", "5q1PTTjK3aS", "6KhIqryeG83", "6cuGuY88hng", "6JZsAHMHpvb"], "total_freq": 59}, {"id": "current", "label": "current", "confidence": 0.92, "tier": 1, "is_free_standing": false, "head_word": "current", "taught_in_slides": ["5zBRyvxOwou", "6eVptVTR2Lx", "6KhIqryeG83", "6cuGuY88hng"], "total_freq": 21}, {"id": "grid", "label": "grid", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "grid", "taught_in_slides": ["6ps7ro4Er5o", "5zBRyvxOwou", "6cuGuY88hng"], "total_freq": 20}, {"id": "power", "label": "power", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "power", "taught_in_slides": ["5zBRyvxOwou", "5q1PTTjK3aS", "6KhIqryeG83"], "total_freq": 23}, {"id": "loop", "label": "loop", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "loop", "taught_in_slides": ["6eVptVTR2Lx", "6KhIqryeG83"], "total_freq": 9}, {"id": "response", "label": "response", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "response", "taught_in_slides": ["6cuGuY88hng", "6JZsAHMHpvb"], "total_freq": 7}, {"id": "system", "label": "system", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "system", "taught_in_slides": ["6ps7ro4Er5o", "6cuGuY88hng"], "total_freq": 13}, {"id": "output", "label": "output", "confidence": 0.9, "tier": 1, "is_free_standing": false, "head_word": "output", "taught_in_slides": ["6eVptVTR2Lx", "6KhIqryeG83"], "total_freq": 4}], "prereq_edges": [{"from": "inverter", "to": "measured-and-transformed", "confidence": 0.57}, {"from": "inverter", "to": "pwm-scheme", "confidence": 0.57}, {"from": "inverter", "to": "current-and-measured", "confidence": 0.57}, {"from": "inverter", "to": "inputs-the-output", "confidence": 0.57}, {"from": "inverter", "to": "scheme-the-inverter", "confidence": 0.57}, {"from": "inverter", "to": "inverter-control-achieves", "confidence": 0.57}, {"from": "inverter", "to": "achieves-the-subjective", "confidence": 0.57}, {"from": "inverter", "to": "nested-loop-structure", "confidence": 0.57}, {"from": "inverter", "to": "structure-you-learned", "confidence": 0.57}, {"from": "inverter", "to": "2-but-let", "confidence": 0.57}, {"from": "inverter", "to": "provides-the-desired", "confidence": 0.57}, {"from": "inverter", "to": "active-and-reactive", "confidence": 0.9}, {"from": "plant-controller-provides", "to": "measured-and-transformed", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "pwm-scheme", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "current-and-measured", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "inputs-the-output", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "scheme-the-inverter", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "inverter-control-achieves", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "achieves-the-subjective", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "nested-loop-structure", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "structure-you-learned", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "2-but-let", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "provides-the-desired", "confidence": 0.57}, {"from": "plant-controller-provides", "to": "active-and-reactive", "confidence": 0.57}, {"from": "power-and-voltage", "to": "inverter", "confidence": 0.57}, {"from": "power-and-voltage", "to": "current-control-let", "confidence": 0.57}, {"from": "power-and-voltage", "to": "voltage-control-power", "confidence": 0.57}, {"from": "power-and-voltage", "to": "primary-power-source", "confidence": 0.57}, {"from": "power-and-voltage", "to": "source-the-inverter", "confidence": 0.57}, {"from": "power-and-voltage", "to": "voltage-while-terminal", "confidence": 0.57}, {"from": "power-and-voltage", "to": "terminal-voltage-depends", "confidence": 0.57}, {"from": "power-and-voltage", "to": "inverter-and-how", "confidence": 0.57}, {"from": "power-and-voltage", "to": "how-the-system", "confidence": 0.57}, {"from": "power-and-voltage", "to": "active-and-reactive", "confidence": 0.57}, {"from": "power-and-voltage", "to": "discussed-current", "confidence": 0.57}, {"from": "power-and-voltage", "to": "reactive-power", "confidence": 0.57}, {"from": "inverter", "to": "current-control-let", "confidence": 0.57}, {"from": "inverter", "to": "voltage-control-power", "confidence": 0.57}, {"from": "inverter", "to": "primary-power-source", "confidence": 0.73}, {"from": "inverter", "to": "source-the-inverter", "confidence": 0.57}, {"from": "inverter", "to": "voltage-while-terminal", "confidence": 0.57}, {"from": "inverter", "to": "terminal-voltage-depends", "confidence": 0.57}, {"from": "inverter", "to": "inverter-and-how", "confidence": 0.57}, {"from": "inverter", "to": "how-the-system", "confidence": 0.57}, {"from": "inverter", "to": "discussed-current", "confidence": 0.57}, {"from": "inverter", "to": "reactive-power", "confidence": 0.73}, {"from": "active-and-reactive", "to": "current-control-let", "confidence": 0.57}, {"from": "active-and-reactive", "to": "voltage-control-power", "confidence": 0.57}, {"from": "active-and-reactive", "to": "primary-power-source", "confidence": 0.73}, {"from": "active-and-reactive", "to": "source-the-inverter", "confidence": 0.57}, {"from": "active-and-reactive", "to": "voltage-while-terminal", "confidence": 0.57}, {"from": "active-and-reactive", "to": "terminal-voltage-depends", "confidence": 0.57}, {"from": "active-and-reactive", "to": "inverter-and-how", "confidence": 0.57}, {"from": "active-and-reactive", "to": "how-the-system", "confidence": 0.57}, {"from": "active-and-reactive", "to": "discussed-current", "confidence": 0.57}, {"from": "active-and-reactive", "to": "reactive-power", "confidence": 0.73}, {"from": "reactive-power", "to": "active-power", "confidence": 0.57}, {"from": "reactive-power", "to": "closed-loop", "confidence": 0.57}, {"from": "reactive-power", "to": "reactive-reference-current", "confidence": 0.57}, {"from": "reactive-power", "to": "approaches-for-managing", "confidence": 0.57}, {"from": "active-and-reactive", "to": "active-power", "confidence": 0.57}, {"from": "active-and-reactive", "to": "closed-loop", "confidence": 0.57}, {"from": "active-and-reactive", "to": "reactive-reference-current", "confidence": 0.57}, {"from": "active-and-reactive", "to": "approaches-for-managing", "confidence": 0.57}, {"from": "primary-power-source", "to": "active-power", "confidence": 0.57}, {"from": "primary-power-source", "to": "closed-loop", "confidence": 0.57}, {"from": "primary-power-source", "to": "reactive-reference-current", "confidence": 0.57}, {"from": "primary-power-source", "to": "approaches-for-managing", "confidence": 0.57}, {"from": "inverter", "to": "active-power", "confidence": 0.57}, {"from": "inverter", "to": "closed-loop", "confidence": 0.57}, {"from": "inverter", "to": "reactive-reference-current", "confidence": 0.57}, {"from": "inverter", "to": "approaches-for-managing", "confidence": 0.57}, {"from": "inverter", "to": "terminal-voltage", "confidence": 0.57}, {"from": "inverter", "to": "reactive-current", "confidence": 0.57}, {"from": "inverter", "to": "short-circuit", "confidence": 0.57}, {"from": "inverter", "to": "short-circuit-ratio", "confidence": 0.57}, {"from": "inverter", "to": "system-voltage", "confidence": 0.57}, {"from": "inverter", "to": "active-current", "confidence": 0.57}, {"from": "inverter", "to": "grid-strength", "confidence": 0.57}, {"from": "inverter", "to": "normal-range", "confidence": 0.57}, {"from": "inverter", "to": "voltage-drive", "confidence": 0.57}, {"from": "inverter", "to": "fault-ride-through-response", "confidence": 0.57}, {"from": "inverter", "to": "ride-through-response-frt", "confidence": 0.57}, {"from": "inverter", "to": "normal-operating-conditions", "confidence": 0.57}, {"from": "inverter", "to": "conditions-where-voltage", "confidence": 0.57}, {"from": "inverter", "to": "voltage-and-frequency", "confidence": 0.57}, {"from": "inverter", "to": "plant-controller-generates", "confidence": 0.57}, {"from": "inverter", "to": "controller-generates-set", "confidence": 0.57}, {"from": "inverter", "to": "generates-set-points", "confidence": 0.57}, {"from": "inverter", "to": "points-for-individual", "confidence": 0.57}, {"from": "inverter", "to": "individual-inverters-what", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "inverter-based-resource-basics", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "basics-and-operations", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "reviewed-some-basic", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "basic-inverter-operating", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "conditions-for-current", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "current-outer-loop", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "outer-loop-reactive", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "loop-reactive-power", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "fault-ride-through-response", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "ibr-control-system", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "system-options-covered", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "normal-conditions", "confidence": 0.57}, {"from": "inverter-operating-principles", "to": "various-ibr", "confidence": 0.57}, {"from": "power-and-voltage", "to": "inverter-based-resource-basics", "confidence": 0.57}, {"from": "power-and-voltage", "to": "basics-and-operations", "confidence": 0.57}, {"from": "power-and-voltage", "to": "reviewed-some-basic", "confidence": 0.57}, {"from": "power-and-voltage", "to": "basic-inverter-operating", "confidence": 0.57}, {"from": "power-and-voltage", "to": "inverter-operating-principles", "confidence": 0.57}, {"from": "power-and-voltage", "to": "conditions-for-current", "confidence": 0.57}, {"from": "power-and-voltage", "to": "current-outer-loop", "confidence": 0.57}, {"from": "power-and-voltage", "to": "outer-loop-reactive", "confidence": 0.57}, {"from": "power-and-voltage", "to": "loop-reactive-power", "confidence": 0.57}, {"from": "power-and-voltage", "to": "fault-ride-through-response", "confidence": 0.57}, {"from": "power-and-voltage", "to": "ibr-control-system", "confidence": 0.57}, {"from": "power-and-voltage", "to": "system-options-covered", "confidence": 0.57}, {"from": "power-and-voltage", "to": "normal-conditions", "confidence": 0.57}, {"from": "power-and-voltage", "to": "various-ibr", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "inverter-based-resource-basics", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "basics-and-operations", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "reviewed-some-basic", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "basic-inverter-operating", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "conditions-for-current", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "current-outer-loop", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "outer-loop-reactive", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "loop-reactive-power", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "ibr-control-system", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "system-options-covered", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "normal-conditions", "confidence": 0.57}, {"from": "fault-ride-through-response", "to": "various-ibr", "confidence": 0.57}], "modifier_pairs": [{"modifier": "how-the-system", "target": "system"}, {"modifier": "ibr-control-system", "target": "system"}, {"modifier": "terminal-voltage", "target": "voltage"}, {"modifier": "desired-voltage", "target": "voltage"}, {"modifier": "grid-voltage", "target": "voltage"}, {"modifier": "system-voltage", "target": "voltage"}, {"modifier": "conditions-where-voltage", "target": "voltage"}, {"modifier": "power-and-voltage", "target": "voltage"}, {"modifier": "manage-current-voltage", "target": "voltage"}, {"modifier": "active-power", "target": "power"}, {"modifier": "reactive-power", "target": "power"}, {"modifier": "voltage-control-power", "target": "power"}, {"modifier": "loop-reactive-power", "target": "reactive-power"}, {"modifier": "follow-the-grid", "target": "grid"}, {"modifier": "inverter-and-grid", "target": "grid"}, {"modifier": "grid-the-inverter", "target": "inverter"}, {"modifier": "present-day-inverter", "target": "inverter"}, {"modifier": "source-the-inverter", "target": "inverter"}, {"modifier": "scheme-the-inverter", "target": "inverter"}, {"modifier": "active-current", "target": "current"}, {"modifier": "discussed-current", "target": "current"}, {"modifier": "reactive-current", "target": "current"}, {"modifier": "conditions-for-current", "target": "current"}, {"modifier": "reactive-reference-current", "target": "current"}, {"modifier": "closed-loop", "target": "loop"}, {"modifier": "current-outer-loop", "target": "loop"}, {"modifier": "inputs-the-output", "target": "output"}, {"modifier": "fault-ride-through-response", "target": "response"}]}, "federation": [{"package": {"id": "_5qwmVc81kwm", "title": "Lesson 2: Inverter Basics", "standard": "SCORM_2004_4", "authoring_tool": "Articulate Storyline", "authoring_version": "3.104.35448.0", "parser_version": "0.3.0", "vocab_version": "0.2.0", "course_id": "lesson2", "course_label": "Lesson 2", "federation_iri_base": "https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/courses/lesson2"}, "stats": {"manifest_items": 1, "manifest_resources": 1, "scenes": 2, "slides": 15, "audio_files": 28, "transcripts": 28, "audio_seconds": 736.1310625, "concepts_total": 128, "concepts_free_standing": 122, "modifier_pairs": 32, "prereq_edges": 323}, "scenes": [{"id": "6RdIHQ8sw43", "title": "Scene 1", "scene_number": 1, "slide_ids": ["5mxvVHmgKIk", "6ps7ro4Er5o", "5zBRyvxOwou", "6eVptVTR2Lx", "5q1PTTjK3aS", "6KhIqryeG83", "5uUiVx1gsqw", "6j4NfYacv8d", "6MvgELbfFIH", "64VkQoxpjPi", "6JZsAHMHpvb", "66RtiTQPuzj", "5XHGBaZwOfD"]}, {"id": "5sFB072XEDS", "title": "Scene 2", "scene_number": 2, "slide_ids": ["6DAYZylYZ4Y", "6IcYxMXh0mW"]}], "slides": [{"id": "5mxvVHmgKIk", "title": "Welcome", "scene_id": "6RdIHQ8sw43", "sequence_index": 0, "lms_id": "Slide1", "audio_count": 0, "transcript_segments": [], "transcript_combined": "", "concept_ids": [], "alt_text_corpus": "title.jpg; Use this title layout.\\\\nIt is ok to change the background image as long as the EPRI gradient overlay remains on this page prominently displayed.\\\\nRemove audio track if the course does not contain any other audio. You may replace with different audio, especially if you are branding a series of courses. \\\\nAdd prerequisite or recommended prior course work or knowledge to this slide if needed.\\\\n\\\\nStart Course \\u2013 Trigger to jump to About This Course.\\\\n; Lesson 2: Inverter Basics; \\u00a9 2025 Ele"}, {"id": "6ps7ro4Er5o", "title": "Introduction", "scene_id": "6RdIHQ8sw43", "sequence_index": 1, "lms_id": "Slide2", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/6gaxzFMDakO_44100_48_0.mp3", "duration": 28.52575, "text": "To understand how inverter-based resources or IBRs interact with the grid, it's essential to start with the fundamentals of power electronics. In this lesson we'll begin by discussing inverter and plant controls along with control scheme timeframes. We'll then discuss in some detail various power electronic concepts, including switches, voltage and current source converters, pulse width modulation and output filters.", "segments": [{"start": 0.0, "end": 6.5200000000000005, "text": "To understand how inverter-based resources or IBRs interact with the grid, it's essential"}, {"start": 6.5200000000000005, "end": 10.24, "text": "to start with the fundamentals of power electronics."}, {"start": 10.24, "end": 15.36, "text": "In this lesson we'll begin by discussing inverter and plant controls along with control"}, {"start": 15.36, "end": 17.12, "text": "scheme timeframes."}, {"start": 17.12, "end": 22.76, "text": "We'll then discuss in some detail various power electronic concepts, including switches,"}, {"start": 22.76, "end": 28.080000000000002, "text": "voltage and current source converters, pulse width modulation and output filters."}]}, {"audio_url": "story_content/6Jq4l5JKCpB_44100_48_0.mp3", "duration": 13.087375, "text": "Upon completion of this lesson, you should be able to describe how different control layers interconnect and coordinate across time scales, and describe the differences between voltage and current source converters.", "segments": [{"start": 0.0, "end": 5.5, "text": "Upon completion of this lesson, you should be able to describe how different control layers"}, {"start": 5.5, "end": 13.0, "text": "interconnect and coordinate across time scales, and describe the differences between voltage and current source converters."}]}], "transcript_combined": "To understand how inverter-based resources or IBRs interact with the grid, it's essential to start with the fundamentals of power electronics. In this lesson we'll begin by discussing inverter and plant controls along with control scheme timeframes. We'll then discuss in some detail various power electronic concepts, including switches, voltage and current source converters, pulse width modulation and output filters. Upon completion of this lesson, you should be able to describe how different control layers interconnect and coordinate across time scales, and describe the differences between voltage and current source converters.", "concept_ids": ["voltage-and-current", "current-source-converters", "how", "power", "inverter-and-plant", "plant-controls-along", "detail-various-power", "various-power-electronic", "power-electronic-concepts", "electronic-concepts-including", "concepts-including-switches", "including-switches-voltage", "source-converters-pulse", "converters-pulse-width", "pulse-width-modulation", "modulation-and-output", "output-filters-upon", "interconnect-and-coordinate", "coordinate-across-time", "across-time-scales"], "alt_text_corpus": ""}, {"id": "5zBRyvxOwou", "title": "Energy Flow from IBRs to the Grid", "scene_id": "6RdIHQ8sw43", "sequence_index": 2, "lms_id": "Slide3", "audio_count": 1, "transcript_segments": [{"audio_url": "story_content/6hBXUhbxkTW_44100_48_0.mp3", "duration": 12.74775, "text": "Shown on the screen is a basic diagram of an IBR plant connection to the transmission system. Click each marker for an overview of the power flow from inverter-based resources to the power grid.", "segments": [{"start": 0.0, "end": 6.0, "text": "Shown on the screen is a basic diagram of an IBR plant connection to the transmission system."}, {"start": 6.0, "end": 13.0, "text": "Click each marker for an overview of the power flow from inverter-based resources to the power grid."}]}], "transcript_combined": "Shown on the screen is a basic diagram of an IBR plant connection to the transmission system. Click each marker for an overview of the power flow from inverter-based resources to the power grid.", "concept_ids": ["flow-from", "grid", "power", "energy-flow-from", "flow-from-ibrs", "ibr-plant-connection", "power-flow-from", "flow-from-inverter-based", "basic-diagram", "transmission-system", "power-grid"], "alt_text_corpus": "Rectangle 6; Image 18.emf; Rectangle 1"}, {"id": "6eVptVTR2Lx", "title": "Inverter and Plant Controls", "scene_id": "6RdIHQ8sw43", "sequence_index": 3, "lms_id": "Slide4", "audio_count": 4, "transcript_segments": [{"audio_url": "story_content/6Hmxu0Rp7KI_44100_48_0.mp3", "duration": 5.250625, "text": "There are two layers of control, inverter and plant level control.", "segments": [{"start": 0.0, "end": 5.0, "text": "There are two layers of control, inverter and plant level control."}]}, {"audio_url": "story_content/5lc3L2JsW3q_44100_48_0.mp3", "duration": 19.9314375, "text": "The inverter level control system for one inverter is shown. Inverter controls are typically implemented in a nested loop structure. Controls in this system include an outer and inner control, pulse width modulation or PWM and phase locked loop or PLL.", "segments": [{"start": 0.0, "end": 4.72, "text": "The inverter level control system for one inverter is shown."}, {"start": 4.72, "end": 9.200000000000001, "text": "Inverter controls are typically implemented in a nested loop structure."}, {"start": 9.200000000000001, "end": 13.120000000000001, "text": "Controls in this system include an outer and inner control,"}, {"start": 13.120000000000001, "end": 19.68, "text": "pulse width modulation or PWM and phase locked loop or PLL."}]}, {"audio_url": "story_content/6f9fCQ5hQb4_44100_48_0.mp3", "duration": 9.9526875, "text": "Along with the inverter level control system, there is also a plant level control system, which generates control commands for inverter level control.", "segments": [{"start": 0.0, "end": 5.6000000000000005, "text": "Along with the inverter level control system, there is also a plant level control system,"}, {"start": 5.6000000000000005, "end": 9.6, "text": "which generates control commands for inverter level control."}]}, {"audio_url": "story_content/6LZHjtvbOOO_44100_48_0.mp3", "duration": 30.1453125, "text": "The plant level controller implements essential transmission grid code requirements at the point of measurement during normal and abnormal operating conditions. This is accomplished by sending control set points to each individual inverter. We assume in this course that the plant controller sends active and reactive power set points to inverter level control. The individual inverter controls output to achieve these set points. In this course, we'll look at how this is done.", "segments": [{"start": 0.0, "end": 9.0, "text": "The plant level controller implements essential transmission grid code requirements at the point of measurement during normal and abnormal operating conditions."}, {"start": 9.0, "end": 14.0, "text": "This is accomplished by sending control set points to each individual inverter."}, {"start": 14.0, "end": 21.0, "text": "We assume in this course that the plant controller sends active and reactive power set points to inverter level control."}, {"start": 21.0, "end": 26.0, "text": "The individual inverter controls output to achieve these set points."}, {"start": 26.0, "end": 30.0, "text": "In this course, we'll look at how this is done."}]}], "transcript_combined": "There are two layers of control, inverter and plant level control. The inverter level control system for one inverter is shown. Inverter controls are typically implemented in a nested loop structure. Controls in this system include an outer and inner control, pulse width modulation or PWM and phase locked loop or PLL. Along with the inverter level control system, there is also a plant level control system, which generates control commands for inverter level control. The plant level controller implements essential transmission grid code requirements at the point of measurement during normal and abnormal operating conditions. This is accomplished by sending control set points to each individual inverter. We assume in this course that the plant controller sends active and reactive power set points to inverter level control. The individual inverter controls output to achieve these set points. In this course, we'll look at how this is done.", "concept_ids": ["level", "inverter-level", "level-control-system", "plant", "plant-level", "set-points", "inverter-and-plant", "individual-inverter", "controller", "nested-loop-structure", "outer-and-inner", "inner-control-pulse", "pulse-width-modulation", "pwm-and-phase", "phase-locked-loop", "system-which-generates", "generates-control-commands", "commands-for-inverter"], "alt_text_corpus": "Rectangle 5; Right Arrow 4; Rectangle 6; Right Arrow 2; Right Arrow 5; Rectangle 3; Image 22.emf; Right Arrow 3; Rectangle 2; Rectangle 7; Rectangle 8; Right Arrow 1; Rectangle 9; Rectangle 4; Rectangle 10; Rectangle 1; Right Arrow 6"}, {"id": "5q1PTTjK3aS", "title": "Inverter and Plant Control Timeframes", "scene_id": "6RdIHQ8sw43", "sequence_index": 4, "lms_id": "Slide5", "audio_count": 1, "transcript_segments": [{"audio_url": "story_content/5zka3Y5AssZ_44100_48_0.mp3", "duration": 62.3281875, "text": "Simple response times of different layers of control are shown in the graph to the right. Notice the differences in the timeframes for the controllers. This separation in controller timeframes simplifies the control design problem. The individual inverter and plant level control schemes operate at different speeds with the individual unit controls acting faster and plant controller acting slower. In general, the lower layer controls in blue react in microseconds to milliseconds, handling fast electrical dynamics. The higher level plant and system responses shown in red operate in hundreds of milliseconds to seconds, managing broader grid support functions like frequency and voltage control. Inverter control is implemented in an nested loop structure without our controls being slower. Take some time to review the timeframes and then click Next for a discussion on power electronic converters and concepts associated within Verters.", "segments": [{"start": 0.0, "end": 6.0, "text": "Simple response times of different layers of control are shown in the graph to the right."}, {"start": 6.0, "end": 9.0, "text": "Notice the differences in the timeframes for the controllers."}, {"start": 9.0, "end": 14.0, "text": "This separation in controller timeframes simplifies the control design problem."}, {"start": 14.0, "end": 19.0, "text": "The individual inverter and plant level control schemes operate at different speeds"}, {"start": 19.0, "end": 25.0, "text": "with the individual unit controls acting faster and plant controller acting slower."}, {"start": 26.0, "end": 31.0, "text": "In general, the lower layer controls in blue react in microseconds to milliseconds,"}, {"start": 31.0, "end": 34.0, "text": "handling fast electrical dynamics."}, {"start": 34.0, "end": 40.0, "text": "The higher level plant and system responses shown in red operate in hundreds of milliseconds"}, {"start": 40.0, "end": 46.0, "text": "to seconds, managing broader grid support functions like frequency and voltage control."}, {"start": 46.0, "end": 52.0, "text": "Inverter control is implemented in an nested loop structure without our controls being slower."}, {"start": 52.0, "end": 59.0, "text": "Take some time to review the timeframes and then click Next for a discussion on power electronic converters"}, {"start": 59.0, "end": 62.0, "text": "and concepts associated within Verters."}]}], "transcript_combined": "Simple response times of different layers of control are shown in the graph to the right. Notice the differences in the timeframes for the controllers. This separation in controller timeframes simplifies the control design problem. The individual inverter and plant level control schemes operate at different speeds with the individual unit controls acting faster and plant controller acting slower. In general, the lower layer controls in blue react in microseconds to milliseconds, handling fast electrical dynamics. The higher level plant and system responses shown in red operate in hundreds of milliseconds to seconds, managing broader grid support functions like frequency and voltage control. Inverter control is implemented in an nested loop structure without our controls being slower. Take some time to review the timeframes and then click Next for a discussion on power electronic converters and concepts associated within Verters.", "concept_ids": ["plant", "inverter-and-plant", "controller", "level", "plant-control-timeframes", "timeframes-simple-response", "simple-response-times", "notice-the-differences", "controllers-this-separation", "controller-timeframes-simplifies", "problem-the-individual", "level-control-schemes", "unit-controls-acting", "faster-and-plant"], "alt_text_corpus": "Rectangle 2; Triangle 1; Image 13.emf; Rectangle 1; Image 12.emf"}, {"id": "6KhIqryeG83", "title": "Power Electronics Overview", "scene_id": "6RdIHQ8sw43", "sequence_index": 5, "lms_id": "Slide6", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/6clJAJkbqLU_44100_48_0.mp3", "duration": 41.9265625, "text": "Power electronic converters are used for IBRs such as photovoltaic arrays and wind and best resources. We'll focus on solar photovoltaic resources in this course. A solar panel generates direct current electricity and cannot be directly connected to the alternating current electric grid. Power electronic converters are used to transfer energy between PV arrays and the electric grid. This transfer is accomplished by synthesizing an output voltage based on the requirements of the grid, allowing safe and reliable energy transfer. In this course we'll look at how this voltage is synthesized by a power electronic converter.", "segments": [{"start": 0.0, "end": 7.12, "text": "Power electronic converters are used for IBRs such as photovoltaic arrays and wind and"}, {"start": 7.12, "end": 8.76, "text": "best resources."}, {"start": 8.76, "end": 13.040000000000001, "text": "We'll focus on solar photovoltaic resources in this course."}, {"start": 13.040000000000001, "end": 18.36, "text": "A solar panel generates direct current electricity and cannot be directly connected to the"}, {"start": 18.36, "end": 21.04, "text": "alternating current electric grid."}, {"start": 21.04, "end": 26.560000000000002, "text": "Power electronic converters are used to transfer energy between PV arrays and the electric"}, {"start": 26.560000000000002, "end": 27.560000000000002, "text": "grid."}, {"start": 27.560000000000002, "end": 32.32, "text": "This transfer is accomplished by synthesizing an output voltage based on the requirements"}, {"start": 32.32, "end": 36.64, "text": "of the grid, allowing safe and reliable energy transfer."}, {"start": 36.64, "end": 41.480000000000004, "text": "In this course we'll look at how this voltage is synthesized by a power electronic converter."}]}, {"audio_url": "story_content/5h9dgd9t9Du_44100_48_0.mp3", "duration": 46.6024375, "text": "Over the next several screens we'll look at 4 power electronic concepts in the context of PV inverters. Power electronic switches are the core components and controlling power flow for my BRs. Within this course when we refer to switches, we are talking about power electronic switches. First, we'll look at how these switches operate. Then, we'll compare voltage source converters with current source converters and discuss why voltage source converters are more common with her newable grid integration applications. We'll examine voltage source converter behavior and how it produces a desired voltage set point. And lastly, we'll look at pulse width modulation or PWM for synthesizing desired output.", "segments": [{"start": 0.0, "end": 7.0, "text": "Over the next several screens we'll look at 4 power electronic concepts in the context of PV inverters."}, {"start": 7.0, "end": 13.0, "text": "Power electronic switches are the core components and controlling power flow for my BRs."}, {"start": 13.0, "end": 19.0, "text": "Within this course when we refer to switches, we are talking about power electronic switches."}, {"start": 19.0, "end": 22.0, "text": "First, we'll look at how these switches operate."}, {"start": 22.0, "end": 27.0, "text": "Then, we'll compare voltage source converters with current source converters"}, {"start": 27.0, "end": 33.0, "text": "and discuss why voltage source converters are more common with her newable grid integration applications."}, {"start": 33.0, "end": 39.0, "text": "We'll examine voltage source converter behavior and how it produces a desired voltage set point."}, {"start": 39.0, "end": 46.0, "text": "And lastly, we'll look at pulse width modulation or PWM for synthesizing desired output."}]}], "transcript_combined": "Power electronic converters are used for IBRs such as photovoltaic arrays and wind and best resources. We'll focus on solar photovoltaic resources in this course. A solar panel generates direct current electricity and cannot be directly connected to the alternating current electric grid. Power electronic converters are used to transfer energy between PV arrays and the electric grid. This transfer is accomplished by synthesizing an output voltage based on the requirements of the grid, allowing safe and reliable energy transfer. In this course we'll look at how this voltage is synthesized by a power electronic converter. Over the next several screens we'll look at 4 power electronic concepts in the context of PV inverters. Power electronic switches are the core components and controlling power flow for my BRs. Within this course when we refer to switches, we are talking about power electronic switches. First, we'll look at how these switches operate. Then, we'll compare voltage source converters with current source converters and discuss why voltage source converters are more common with her newable grid integration applications. We'll examine voltage source converter behavior and how it produces a desired voltage set point. And lastly, we'll look at pulse width modulation or PWM for synthesizing desired output.", "concept_ids": ["power-electronic", "voltage", "voltage-source", "source-converters", "grid", "switches", "power-electronic-converters", "power-electronic-switches", "voltage-source-converters", "current", "how", "output"], "alt_text_corpus": "PV arrays generate DC electricity; AdobeStock_1555366827.jpg; AdobeStock_1036839997.jpg; Power electronics switches \\\\nVoltage-sourced converter vs current-sourced converter\\\\nAnalysis of voltage-sourced converter \\\\nPulse-width modulation; Image 22.emf; Voltage-sourced converter vs current-sourced converter; Analysis of voltage-sourced converter; Electric grid requires AC electricity; Pulse-width modulation; Power electronics switches; Rectangle 1; PV arrays generate DC electricity\\\\nElectric grid "}, {"id": "5uUiVx1gsqw", "title": "Power Electronic Switches", "scene_id": "6RdIHQ8sw43", "sequence_index": 6, "lms_id": "Slide7", "audio_count": 3, "transcript_segments": [{"audio_url": "story_content/6RyE4RqohXT_44100_48_0.mp3", "duration": 13.16575, "text": "Power electronics which is allowing Verters to rapidly switch DC input into controlled AC output. They enable precise control of power flow by turning on and off at high frequencies.", "segments": [{"start": 0.0, "end": 2.46, "text": "Power electronics which is allowing"}, {"start": 2.46, "end": 7.140000000000001, "text": "Verters to rapidly switch DC input into controlled AC output."}, {"start": 7.140000000000001, "end": 12.82, "text": "They enable precise control of power flow by turning on and off at high frequencies."}]}, {"audio_url": "story_content/60TUopY1aRY_44100_48_0.mp3", "duration": 13.4791875, "text": "Let's discuss two switch examples, a line commutated switch called a thyristor, and a controllable switch called an IGBT. Click on the images to learn more. Click continue when you're finished.", "segments": [{"start": 0.0, "end": 9.0, "text": "Let's discuss two switch examples, a line commutated switch called a thyristor, and a controllable switch called an IGBT."}, {"start": 9.0, "end": 13.0, "text": "Click on the images to learn more. Click continue when you're finished."}]}, {"audio_url": "story_content/6l8TlxwDCwG_44100_48_0.mp3", "duration": 39.0269375, "text": "So, which power electronic switch features are critically important for renewable energy integration? A switch should be able to turn on and off multiple times during each cycle of the fundamental frequency. Because switches are temperature sensitive, the current passing through the switch must be strictly controlled to prevent the switches from overheating. This would mean values between 1.1 and 1.5 per unit, depending on the type of switch. Traditional systems are designed for high-fault current contribution from classical synchronous generators. So the fact that IBRs are limited could present some issues for system protection.", "segments": [{"start": 0.0, "end": 6.6000000000000005, "text": "So, which power electronic switch features are critically important for renewable energy integration?"}, {"start": 6.6000000000000005, "end": 12.8, "text": "A switch should be able to turn on and off multiple times during each cycle of the fundamental frequency."}, {"start": 12.8, "end": 20.900000000000002, "text": "Because switches are temperature sensitive, the current passing through the switch must be strictly controlled to prevent the switches from overheating."}, {"start": 20.900000000000002, "end": 27.1, "text": "This would mean values between 1.1 and 1.5 per unit, depending on the type of switch."}, {"start": 27.1, "end": 33.6, "text": "Traditional systems are designed for high-fault current contribution from classical synchronous generators."}, {"start": 33.6, "end": 38.6, "text": "So the fact that IBRs are limited could present some issues for system protection."}]}], "transcript_combined": "Power electronics which is allowing Verters to rapidly switch DC input into controlled AC output. They enable precise control of power flow by turning on and off at high frequencies. Let's discuss two switch examples, a line commutated switch called a thyristor, and a controllable switch called an IGBT. Click on the images to learn more. Click continue when you're finished. So, which power electronic switch features are critically important for renewable energy integration? A switch should be able to turn on and off multiple times during each cycle of the fundamental frequency. Because switches are temperature sensitive, the current passing through the switch must be strictly controlled to prevent the switches from overheating. This would mean values between 1.1 and 1.5 per unit, depending on the type of switch. Traditional systems are designed for high-fault current contribution from classical synchronous generators. So the fact that IBRs are limited could present some issues for system protection.", "concept_ids": ["power", "power-electronic", "switch-called", "switches", "current", "power-electronic-switches", "switches-power-electronics", "input-into-controlled", "output-they-enable", "high-frequencies-let", "commutated-switch-called", "controllable-switch-called", "power-electronic-switch", "electronic-switch-features", "features-are-critically", "important-for-renewable"], "alt_text_corpus": "For HVDC LCC, SVC, & large drive apps\\\\nSwitch On\\\\nLatches on, gate pulse can be removed\\\\nForward blocking region and gate pulse\\\\nia > 0\\\\nSwitch Off\\\\nWhen ia tries to go < 0\\\\nOne-way current flow; Provide strictly controlled current                                (between 1.1 and 1.5 per unit); Screenshot_16-10-2025_151748_app.box.com.jpg; Image 22.emf; Line Commutated: Thyristor; AdobeStock_1253354469.jpg; Controllable Switch: IGBT; CONTINUE; Common for PWM apps\\\\nSwitch On:\\\\nApplication of gate "}, {"id": "6j4NfYacv8d", "title": "Voltage and Current Sources", "scene_id": "6RdIHQ8sw43", "sequence_index": 7, "lms_id": "Slide8", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/5jL0FEsO8pC_44100_48_0.mp3", "duration": 16.1959375, "text": "Recall that power electronic converters are used to transfer energy between the PV arrays and the electric grid. Their function is to regulate voltage magnitude, frequency and phase, so that power can be delivered reliably and in sync with the grid.", "segments": [{"start": 0.0, "end": 7.0, "text": "Recall that power electronic converters are used to transfer energy between the PV arrays and the electric grid."}, {"start": 7.0, "end": 16.0, "text": "Their function is to regulate voltage magnitude, frequency and phase, so that power can be delivered reliably and in sync with the grid."}]}, {"audio_url": "story_content/5ok1C58mJev_44100_48_0.mp3", "duration": 37.06775, "text": "This illustration reviews the concept of an ideal voltage source and an ideal current source. The power electronic interface provides the capability and flexibility to be operated as a voltage source or as a current source. By changing the control, you can implement both modes of operation. With an ideal voltage source, the interface controls voltage across its terminals and the current can be variable. With an ideal current source, the interface implements or controls the current output and the voltage across its terminal can be variable depending on grid condition.", "segments": [{"start": 0.0, "end": 7.0, "text": "This illustration reviews the concept of an ideal voltage source and an ideal current source."}, {"start": 7.0, "end": 15.0, "text": "The power electronic interface provides the capability and flexibility to be operated as a voltage source or as a current source."}, {"start": 15.0, "end": 19.0, "text": "By changing the control, you can implement both modes of operation."}, {"start": 19.0, "end": 26.0, "text": "With an ideal voltage source, the interface controls voltage across its terminals and the current can be variable."}, {"start": 26.0, "end": 36.0, "text": "With an ideal current source, the interface implements or controls the current output and the voltage across its terminal can be variable depending on grid condition."}]}], "transcript_combined": "Recall that power electronic converters are used to transfer energy between the PV arrays and the electric grid. Their function is to regulate voltage magnitude, frequency and phase, so that power can be delivered reliably and in sync with the grid. This illustration reviews the concept of an ideal voltage source and an ideal current source. The power electronic interface provides the capability and flexibility to be operated as a voltage source or as a current source. By changing the control, you can implement both modes of operation. With an ideal voltage source, the interface controls voltage across its terminals and the current can be variable. With an ideal current source, the interface implements or controls the current output and the voltage across its terminal can be variable depending on grid condition.", "concept_ids": ["voltage", "current", "source", "voltage-source", "current-source", "ideal-voltage-source", "ideal-current-source", "source-the-interface", "power-electronic", "voltage-across", "grid", "voltage-and-current", "current-sources-recall", "recall-that-power", "power-electronic-converters", "grid-their-function", "regulate-voltage-magnitude", "voltage-magnitude-frequency"], "alt_text_corpus": "PV arrays generate DC electricity; PV arrays generate DC electricity\\\\nElectric grid requires AC electricity\\\\nPower electronic converters control the output voltage (magnitude, frequency, and phase) based on the grid; Image 22.emf; Voltage maintained at terminal despite current passing through ; Current maintained through terminals regardless of  voltage across device; Electric grid requires AC electricity; Power electronic converters control the output voltage (magnitude, frequency, and phase) b"}, {"id": "6MvgELbfFIH", "title": "Voltage Source Converters (VSCs) vs. Current Source Converters (CSCs)", "scene_id": "6RdIHQ8sw43", "sequence_index": 8, "lms_id": "Slide9", "audio_count": 2, "transcript_segments": [{"audio_url": "story_content/6VWyKAHFS6G_44100_48_0.mp3", "duration": 37.250625, "text": "There are two primary physical structures for the power electronic interface, the voltage source converter or VSC and the current source converter or CSC. This classification is based on hardware design, not on control method or resource type. While VSCs and CSCs differ in design, both can be controlled to function as either a voltage source or a current source. For example, each can emulate an AC current source or regulate voltage at the point of interconnection. A VSC is more commonly used in renewables applications.", "segments": [{"start": 0.0, "end": 5.2, "text": "There are two primary physical structures for the power electronic interface,"}, {"start": 5.2, "end": 11.48, "text": "the voltage source converter or VSC and the current source converter or CSC."}, {"start": 11.48, "end": 17.92, "text": "This classification is based on hardware design, not on control method or resource type."}, {"start": 17.92, "end": 23.84, "text": "While VSCs and CSCs differ in design, both can be controlled to function as either a voltage"}, {"start": 23.84, "end": 26.04, "text": "source or a current source."}, {"start": 26.04, "end": 31.439999999999998, "text": "For example, each can emulate an AC current source or regulate voltage at the point of"}, {"start": 31.439999999999998, "end": 32.44, "text": "interconnection."}, {"start": 32.44, "end": 36.68, "text": "A VSC is more commonly used in renewables applications."}]}, {"audio_url": "story_content/6Yh9UfuJHd5_44100_48_0.mp3", "duration": 10.9975625, "text": "VSCs and CSCs are structurally different, but both can meet the same control objectives when properly configured. Click each type of converter to learn how they differ.", "segments": [{"start": 0.0, "end": 7.5600000000000005, "text": "VSCs and CSCs are structurally different, but both can meet the same control objectives when properly configured."}, {"start": 7.5600000000000005, "end": 10.8, "text": "Click each type of converter to learn how they differ."}]}], "transcript_combined": "There are two primary physical structures for the power electronic interface, the voltage source converter or VSC and the current source converter or CSC. This classification is based on hardware design, not on control method or resource type. While VSCs and CSCs differ in design, both can be controlled to function as either a voltage source or a current source. For example, each can emulate an AC current source or regulate voltage at the point of interconnection. A VSC is more commonly used in renewables applications. VSCs and CSCs are structurally different, but both can meet the same control objectives when properly configured. Click each type of converter to learn how they differ.", "concept_ids": ["source", "current-source", "voltage-source", "vscs-and-cscs", "source-converters", "source-converter", "vsc", "voltage-source-converters", "source-converters-vscs", "current-source-converters", "source-converters-cscs", "primary-physical-structures", "power-electronic-interface", "interface-the-voltage", "voltage-source-converter", "current-source-converter", "csc-this-classification"], "alt_text_corpus": "Image 35.emf; Voltage-Sourced Converter (VSC); Voltage Source Converters (VSCs) are commonly used in renewable energy applications. They use a DC capacitor behind its switches. A larger capacitance results in a stiffer voltage source.\\\\nCurrent Control: The VSC operates as a current source by using a high-bandwidth current control loop to synthesize terminal voltage, ensuring current follows a setpoint.\\\\nVoltage Control: The VSC mimics a voltage source using a nested control loop. The outer loop "}, {"id": "64VkQoxpjPi", "title": "VSC Topology Samples", "scene_id": "6RdIHQ8sw43", "sequence_index": 9, "lms_id": "Slide10", "audio_count": 1, "transcript_segments": [{"audio_url": "story_content/5qwKpICBARX_44100_48_0.mp3", "duration": 13.7665625, "text": "Let's look at an example of a topology. In this case, a two-level three-phase voltage sourced converter. Click each labeled button to learn the basic structure and operation of this VSC.", "segments": [{"start": 0.0, "end": 6.5200000000000005, "text": "Let's look at an example of a topology. In this case, a two-level three-phase voltage"}, {"start": 6.5200000000000005, "end": 11.92, "text": "sourced converter. Click each labeled button to learn the basic structure and operation"}, {"start": 11.92, "end": 13.16, "text": "of this VSC."}]}], "transcript_combined": "Let's look at an example of a topology. In this case, a two-level three-phase voltage sourced converter. Click each labeled button to learn the basic structure and operation of this VSC.", "concept_ids": ["vsc", "vsc-topology-samples", "topology-samples-let", "two-level-three-phase-voltage", "three-phase-voltage-sourced", "voltage-sourced-converter", "learn-the-basic", "structure-and-operation", "basic-structure"], "alt_text_corpus": "Image 34.emf; Two-Level VSC: Consists of a six-pulse IGBT bridge with inverse-parallel diodes. The AC terminal voltage of each phase switches between the positive and negative DC terminal values\\\\n\\\\nThree-Phase Configuration: Involves three legs, each corresponding to one phase of the AC output.; Image 31.emf; Image 33.emf; PWM: Used to control the switching of IGBTs, allowing the converter to generate a desired AC waveform.\\\\n\\\\nAC side LC filter: Essential for maintaining the quality of the outpu"}, {"id": "6JZsAHMHpvb", "title": "Pulse Width Modulation (PWM)", "scene_id": "6RdIHQ8sw43", "sequence_index": 10, "lms_id": "Slide11", "audio_count": 5, "transcript_segments": [{"audio_url": "story_content/6qsMyHCtA4X_44100_48_0.mp3", "duration": 29.622875, "text": "Pulse with modulation or PWM is used to synthesize an output voltage at the desired magnitude and frequency. The inverter control develops the voltage reference. We'll discuss this more in the next lesson. For now, let's examine how PWM synthesizes an output voltage in an ideal PWM scheme. We'll assume that the inverter control is perfect and that we have a voltage reference for the desired P and Q output.", "segments": [{"start": 0.0, "end": 8.0, "text": "Pulse with modulation or PWM is used to synthesize an output voltage at the desired magnitude and frequency."}, {"start": 8.0, "end": 14.0, "text": "The inverter control develops the voltage reference. We'll discuss this more in the next lesson."}, {"start": 14.0, "end": 21.0, "text": "For now, let's examine how PWM synthesizes an output voltage in an ideal PWM scheme."}, {"start": 21.0, "end": 29.0, "text": "We'll assume that the inverter control is perfect and that we have a voltage reference for the desired P and Q output."}]}, {"audio_url": "story_content/6nqB0KrYycX_44100_48_0.mp3", "duration": 48.7445, "text": "The control generates a low-level sinusoidal reference voltage which is sent to the modulator. The modulator then determines the pulse width supplied to switches S1 and S4 of phase A by comparing the sinusoidal reference voltage to a triangular waveform at the switching frequency. When the sinusoidal waveform is larger than the triangular waveform, a gate pulse for switch SA plus or S1 is generated and the gate pulse for switch SA minus is removed. By contrast, when the sinusoidal waveform is smaller than the triangular waveform, a gate pulse for switch SA minus is generated and the gate pulse for switch SA plus or S4 is removed. A similar scheme could be provided for phases B and C.", "segments": [{"start": 0.0, "end": 6.0, "text": "The control generates a low-level sinusoidal reference voltage which is sent to the modulator."}, {"start": 6.0, "end": 12.4, "text": "The modulator then determines the pulse width supplied to switches S1 and S4 of phase A"}, {"start": 12.4, "end": 18.2, "text": "by comparing the sinusoidal reference voltage to a triangular waveform at the switching frequency."}, {"start": 18.2, "end": 22.8, "text": "When the sinusoidal waveform is larger than the triangular waveform,"}, {"start": 22.8, "end": 31.200000000000003, "text": "a gate pulse for switch SA plus or S1 is generated and the gate pulse for switch SA minus is removed."}, {"start": 31.200000000000003, "end": 36.2, "text": "By contrast, when the sinusoidal waveform is smaller than the triangular waveform,"}, {"start": 36.2, "end": 44.400000000000006, "text": "a gate pulse for switch SA minus is generated and the gate pulse for switch SA plus or S4 is removed."}, {"start": 44.400000000000006, "end": 48.400000000000006, "text": "A similar scheme could be provided for phases B and C."}]}, {"audio_url": "story_content/5fwre3OlsP8_44100_48_0.mp3", "duration": 29.1526875, "text": "Showner the S1 pulse widths and S4 pulse widths for phase A. A triangular waveform is shown in the top graph. In the first cycles, the time that the S1 switch is on is reduced, generating the negative part of the waveform. In the next cycles, the gates are kept on the same amount of time, so the voltage is close to zero. Then, the S1 switch is kept on longer than the S4 switch, generating the positive part of the waveform.", "segments": [{"start": 0.0, "end": 6.74, "text": "Showner the S1 pulse widths and S4 pulse widths for phase A. A triangular waveform"}, {"start": 6.74, "end": 13.280000000000001, "text": "is shown in the top graph. In the first cycles, the time that the S1 switch is on is reduced,"}, {"start": 13.280000000000001, "end": 18.04, "text": "generating the negative part of the waveform. In the next cycles, the gates are kept"}, {"start": 18.04, "end": 23.48, "text": "on the same amount of time, so the voltage is close to zero. Then, the S1 switch is"}, {"start": 23.48, "end": 30.48, "text": "kept on longer than the S4 switch, generating the positive part of the waveform."}]}, {"audio_url": "story_content/64ewnC3lfyd_44100_48_0.mp3", "duration": 20.819625, "text": "The terminal voltage contains switching harmonics, which are at the same switching frequency and side bands of the switching frequency. 60 hertz is the fundamental frequency, and then there are several harmonics around the switching frequency. It's important that undesirable harmonics are eliminated using an output filter.", "segments": [{"start": 0.0, "end": 8.0, "text": "The terminal voltage contains switching harmonics, which are at the same switching frequency and side bands of the switching frequency."}, {"start": 8.0, "end": 15.0, "text": "60 hertz is the fundamental frequency, and then there are several harmonics around the switching frequency."}, {"start": 15.0, "end": 20.0, "text": "It's important that undesirable harmonics are eliminated using an output filter."}]}, {"audio_url": "story_content/6LYrmYZYMr9_44100_48_0.mp3", "duration": 50.5991875, "text": "NLC or inductor capacitor filter behaves like a low pass filter, and the cutoff frequency is such that the fundamental frequency component is maintained. The high frequency harmonics around the switching frequency are tamped down. NLCL or inductor capacitor inductor filter can also be used to decrease the size of the inductor. Use Lc and rely on the inductance of the grid to add the missing component of the filter. There is a trade-off with switching frequency and filter requirements. A higher switching frequency leads to higher order harmonics, which can be more easily filtered out using a more compact Lc filter. However, high switching frequency leads to more switching losses and reduced converter efficiency. Click next now for the lesson conclusion.", "segments": [{"start": 0.0, "end": 6.8, "text": "NLC or inductor capacitor filter behaves like a low pass filter, and the cutoff frequency"}, {"start": 6.8, "end": 10.92, "text": "is such that the fundamental frequency component is maintained."}, {"start": 10.92, "end": 15.58, "text": "The high frequency harmonics around the switching frequency are tamped down."}, {"start": 15.58, "end": 21.400000000000002, "text": "NLCL or inductor capacitor inductor filter can also be used to decrease the size of"}, {"start": 21.400000000000002, "end": 22.64, "text": "the inductor."}, {"start": 22.64, "end": 28.48, "text": "Use Lc and rely on the inductance of the grid to add the missing component of the filter."}, {"start": 28.48, "end": 32.1, "text": "There is a trade-off with switching frequency and filter requirements."}, {"start": 32.1, "end": 37.72, "text": "A higher switching frequency leads to higher order harmonics, which can be more easily filtered"}, {"start": 37.72, "end": 40.480000000000004, "text": "out using a more compact Lc filter."}, {"start": 40.480000000000004, "end": 45.72, "text": "However, high switching frequency leads to more switching losses and reduced converter"}, {"start": 45.72, "end": 47.24, "text": "efficiency."}, {"start": 47.24, "end": 49.760000000000005, "text": "Click next now for the lesson conclusion."}]}], "transcript_combined": "Pulse with modulation or PWM is used to synthesize an output voltage at the desired magnitude and frequency. The inverter control develops the voltage reference. We'll discuss this more in the next lesson. For now, let's examine how PWM synthesizes an output voltage in an ideal PWM scheme. We'll assume that the inverter control is perfect and that we have a voltage reference for the desired P and Q output. The control generates a low-level sinusoidal reference voltage which is sent to the modulator. The modulator then determines the pulse width supplied to switches S1 and S4 of phase A by comparing the sinusoidal reference voltage to a triangular waveform at the switching frequency. When the sinusoidal waveform is larger than the triangular waveform, a gate pulse for switch SA plus or S1 is generated and the gate pulse for switch SA minus is removed. By contrast, when the sinusoidal waveform is smaller than the triangular waveform, a gate pulse for switch SA minus is generated and the gate pulse for switch SA plus or S4 is removed. A similar scheme could be provided for phases B and C. Showner the S1 pulse widths and S4 pulse widths for phase A. A triangular waveform is shown in the top graph. In the first cycles, the time that the S1 switch is on is reduced, generating the negative part of the waveform. In the next cycles, the gates are kept on the same amount of time, so the voltage is close to zero. Then, the S1 switch is kept on longer than the S4 switch, generating the positive part of the waveform. The terminal voltage contains switching harmonics, which are at the same switching frequency and side bands of the switching frequency. 60 hertz is the fundamental frequency, and then there are several harmonics around the switching frequency. It's important that undesirable harmonics are eliminated using an output filter. NLC or inductor capacitor filter behaves like a low pass filter, and the cutoff frequency is such that the fundamental frequency component is maintained. The high frequency harmonics around the switching frequency are tamped down. NLCL or inductor capacitor inductor filter can also be used to decrease the size of the inductor. Use Lc and rely on the inductance of the grid to add the missing component of the filter. There is a trade-off with switching frequency and filter requirements. A higher switching frequency leads to higher order harmonics, which can be more easily filtered out using a more compact Lc filter. However, high switching frequency leads to more switching losses and reduced converter efficiency. Click next now for the lesson conclusion.", "concept_ids": ["switching-frequency", "voltage", "pulse-for-switch", "triangular-waveform", "gate-pulse", "output", "sinusoidal-reference-voltage", "around-the-switching", "switching-frequency-leads", "pulse-width", "output-voltage", "sinusoidal-waveform"], "alt_text_corpus": "Rectangle 6; Rectangle 11; Higher Switching Frequency:; Note: Tradeoff between switching frequency and filter requirements; Rectangle 8; Rectangle 10; Rectangle 5; S4; Up Arrow 3; LPF applied to reduce high-frequency content; Higher order harmonics easily filter with compact LC filter; Up Arrow 4; More switching losses and reduced converter efficiency; Image 23.emf; Image 25.emf; Right Arrow 1; Rectangle 9; LCL (or LC + Lgrid) decreases the size of the L needed; Rectangle 1; Up Arrow 5; Rectangl"}, {"id": "66RtiTQPuzj", "title": "Conclusion", "scene_id": "6RdIHQ8sw43", "sequence_index": 11, "lms_id": "Slide12", "audio_count": 4, "transcript_segments": [{"audio_url": "story_content/6c6h3gw7imQ_44100_48_0.mp3", "duration": 6.791875, "text": "You have now completed the second lesson of the inverter-based resources basics and operations course.", "segments": [{"start": 0.0, "end": 7.0, "text": "You have now completed the second lesson of the inverter-based resources basics and operations course."}]}, {"audio_url": "story_content/6cnvKgiVmjD_44100_48_0.mp3", "duration": 13.1135, "text": "You learned about some features of inverter and plant controls, and how the individual inverter and plant level controls schemes operate at different speeds, with the individual inverter controls acting faster.", "segments": [{"start": 0.0, "end": 13.0, "text": "You learned about some features of inverter and plant controls, and how the individual inverter and plant level controls schemes operate at different speeds, with the individual inverter controls acting faster."}]}, {"audio_url": "story_content/6Z8paIPGGjc_44100_48_0.mp3", "duration": 14.5501875, "text": "You then reviewed power electronic concepts pertinent to IBR integration with traditional power resources. These included switches, voltage and current sourced converters, pulse width modulation and output filters.", "segments": [{"start": 0.0, "end": 5.8, "text": "You then reviewed power electronic concepts pertinent to IBR integration with traditional"}, {"start": 5.8, "end": 7.48, "text": "power resources."}, {"start": 7.48, "end": 12.96, "text": "These included switches, voltage and current sourced converters, pulse width modulation"}, {"start": 12.96, "end": 14.200000000000001, "text": "and output filters."}]}, {"audio_url": "story_content/5b3CG0SdgY6_44100_48_0.mp3", "duration": 11.2588125, "text": "You should now be able to describe how different control layers interconnect and coordinate across time scales and describe the differences between voltage and current sourced converters.", "segments": [{"start": 0.0, "end": 5.28, "text": "You should now be able to describe how different control layers interconnect and coordinate"}, {"start": 5.28, "end": 10.120000000000001, "text": "across time scales and describe the differences between voltage and current sourced"}, {"start": 10.120000000000001, "end": 10.96, "text": "converters."}]}], "transcript_combined": "You have now completed the second lesson of the inverter-based resources basics and operations course. You learned about some features of inverter and plant controls, and how the individual inverter and plant level controls schemes operate at different speeds, with the individual inverter controls acting faster. You then reviewed power electronic concepts pertinent to IBR integration with traditional power resources. These included switches, voltage and current sourced converters, pulse width modulation and output filters. You should now be able to describe how different control layers interconnect and coordinate across time scales and describe the differences between voltage and current sourced converters.", "concept_ids": ["inverter-and-plant", "voltage-and-current", "current-sourced-converters", "individual-inverter", "how", "power", "inverter-based-resources-basics", "basics-and-operations", "how-the-individual", "level-controls-schemes", "inverter-controls-acting", "reviewed-power-electronic", "power-electronic-concepts", "electronic-concepts-pertinent", "integration-with-traditional", "included-switches-voltage", "sourced-converters-pulse", "converters-pulse-width", "pulse-width-modulation", "modulation-and-output"], "alt_text_corpus": "You have now completed Lesson 2: Inverter Basics; AdobeStock_1555366827.jpg; Image 13.emf; Image 12.emf"}, {"id": "5XHGBaZwOfD", "title": "Thank You", "scene_id": "6RdIHQ8sw43", "sequence_index": 12, "lms_id": "Slide13", "audio_count": 1, "transcript_segments": [{"audio_url": "story_content/5lCm0CvEUym_44100_48_0.mp3", "duration": 60.029375, "text": "Thank you.", "segments": [{"start": 0.0, "end": 29.84, "text": "Thank you."}]}], "transcript_combined": "Thank you.", "concept_ids": [], "alt_text_corpus": "Thank you for your participation in \\\\nLesson 2: Inverter Basics.\\\\n\\\\rSelect the Exit button to end this course.; Exit; EPRI training_editable backgrounds EXIT.jpg; Instructions for Developer:\\\\n\\\\nThis slide must be included in all courses.\\\\nThis slide must contain the course title, the EPRI U graphic, and an Exit button.\\\\nThe background image and other features can be changed to fit each course.\\\\nRemove the music if the course does not contain audio, or change the music if desired."}, {"id": "6DAYZylYZ4Y", "title": "Navigating This Course", "scene_id": "5sFB072XEDS", "sequence_index": 0, "lms_id": "Slide1", "audio_count": 0, "transcript_segments": [], "transcript_combined": "", "concept_ids": [], "alt_text_corpus": "Submit.png; Adjustable Player Settings; Arrow 1; On the playbar, you can switch closed captioning on or off. This can be accomplished by selecting the closed captioning button once for on and a second time for off. \\\\n\\\\nNote: The closed captioning button will not be present if there is no audio or if the audio is not captioned.; CC.png; Close.png; instructions-bg.jpg; Glossary Navigation.png; Full Screen Toggle; Customize your learning experience by selecting the gear icon and changing the adjust"}, {"id": "6IcYxMXh0mW", "title": "About This Course", "scene_id": "5sFB072XEDS", "sequence_index": 1, "lms_id": "Slide2", "audio_count": 0, "transcript_segments": [], "transcript_combined": "", "concept_ids": [], "alt_text_corpus": "Disclaimer; template3.jpg; About EPRI\\\\n\\\\nFounded in 1972, EPRI is the world\\u2019s preeminent independent, non-profit energy research and development organization, with offices around the world. EPRI\\u2019s trusted experts collaborate with more than 450 companies in 45 countries, driving innovation to ensure the public has clean, safe, reliable, affordable, and equitable access to electricity across the globe. Together, we are shaping the future of energy.\\\\n\\\\n; \\\\n\\\\nAcknowledgments\\\\n\\\\nEPRI would like to ac"}], "concepts": [{"id": "voltage-and-current", "label": "voltage and current", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "current", "taught_in_slides": ["6ps7ro4Er5o", "6j4NfYacv8d", "66RtiTQPuzj"], "total_freq": 5}, {"id": "inverter-and-plant", "label": "inverter and plant", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "plant", "taught_in_slides": ["6ps7ro4Er5o", "6eVptVTR2Lx", "5q1PTTjK3aS", "66RtiTQPuzj"], "total_freq": 7}, {"id": "switches", "label": "switches", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "switches", "taught_in_slides": ["6KhIqryeG83", "5uUiVx1gsqw"], "total_freq": 7}, {"id": "how", "label": "how", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "how", "taught_in_slides": ["6ps7ro4Er5o", "6KhIqryeG83", "66RtiTQPuzj"], "total_freq": 7}, {"id": "plant", "label": "plant", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "plant", "taught_in_slides": ["6eVptVTR2Lx", "5q1PTTjK3aS"], "total_freq": 9}, {"id": "current-source", "label": "current source", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "source", "taught_in_slides": ["6j4NfYacv8d", "6MvgELbfFIH"], "total_freq": 7}, {"id": "voltage-source", "label": "voltage source", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "source", "taught_in_slides": ["6KhIqryeG83", "6j4NfYacv8d", "6MvgELbfFIH"], "total_freq": 9}, {"id": "source", "label": "source", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "source", "taught_in_slides": ["6j4NfYacv8d", "6MvgELbfFIH"], "total_freq": 13}, {"id": "source-converters", "label": "source converters", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "converters", "taught_in_slides": ["6KhIqryeG83", "6MvgELbfFIH"], "total_freq": 5}, {"id": "power-electronic", "label": "power electronic", "confidence": 0.94, "tier": 1, "is_free_standing": true, "head_word": "electronic", "taught_in_slides": ["6KhIqryeG83", "5uUiVx1gsqw", "6j4NfYacv8d"], "total_freq": 10}, {"id": "vsc", "label": "vsc", "confidence": 0.93, "tier": 1, "is_free_standing": true, "head_word": "vsc", "taught_in_slides": ["6MvgELbfFIH", "64VkQoxpjPi"], "total_freq": 4}, {"id": "individual-inverter", "label": "individual inverter", "confidence": 0.93, "tier": 1, "is_free_standing": true, "head_word": "inverter", "taught_in_slides": ["6eVptVTR2Lx", "66RtiTQPuzj"], "total_freq": 4}, {"id": "controller", "label": "controller", "confidence": 0.93, "tier": 1, "is_free_standing": true, "head_word": "controller", "taught_in_slides": ["6eVptVTR2Lx", "5q1PTTjK3aS"], "total_freq": 4}, {"id": "voltage-source-converters", "label": "voltage source converters", "confidence": 0.92, "tier": 1, "is_free_standing": true, "head_word": "converters", "taught_in_slides": ["6KhIqryeG83", "6MvgELbfFIH"], "total_freq": 3}, {"id": "power-electronic-converters", "label": "power electronic converters", "confidence": 0.92, "tier": 1, "is_free_standing": true, "head_word": "converters", "taught_in_slides": ["6KhIqryeG83", "6j4NfYacv8d"], "total_freq": 3}, {"id": "current-source-converters", "label": "current source converters", "confidence": 0.92, "tier": 1, "is_free_standing": true, "head_word": "converters", "taught_in_slides": ["6ps7ro4Er5o", "6MvgELbfFIH"], "total_freq": 3}, {"id": "pulse-width-modulation", "label": "pulse width modulation", "confidence": 0.92, "tier": 1, "is_free_standing": true, "head_word": "modulation", "taught_in_slides": ["6ps7ro4Er5o", "6eVptVTR2Lx", "66RtiTQPuzj"], "total_freq": 3}, {"id": "power-electronic-switches", "label": "power electronic switches", "confidence": 0.92, "tier": 1, "is_free_standing": true, "head_word": "switches", "taught_in_slides": ["6KhIqryeG83", "5uUiVx1gsqw"], "total_freq": 3}, {"id": "modulation-and-output", "label": "modulation and output", "confidence": 0.91, "tier": 1, "is_free_standing": true, "head_word": "output", "taught_in_slides": ["6ps7ro4Er5o", "66RtiTQPuzj"], "total_freq": 2}, {"id": "power-electronic-concepts", "label": "power electronic concepts", "confidence": 0.91, "tier": 1, "is_free_standing": true, "head_word": "concepts", "taught_in_slides": ["6ps7ro4Er5o", "66RtiTQPuzj"], "total_freq": 2}, {"id": "converters-pulse-width", "label": "converters pulse width", "confidence": 0.91, "tier": 1, "is_free_standing": true, "head_word": "width", "taught_in_slides": ["6ps7ro4Er5o", "66RtiTQPuzj"], "total_freq": 2}, {"id": "switching-frequency", "label": "switching frequency", "confidence": 0.73, "tier": 2, "is_free_standing": true, "head_word": "frequency", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 8}, {"id": "pulse-for-switch", "label": "pulse for switch", "confidence": 0.72, "tier": 2, "is_free_standing": true, "head_word": "switch", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 4}, {"id": "gate-pulse", "label": "gate pulse", "confidence": 0.72, "tier": 2, "is_free_standing": true, "head_word": "pulse", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 4}, {"id": "triangular-waveform", "label": "triangular waveform", "confidence": 0.72, "tier": 2, "is_free_standing": true, "head_word": "waveform", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 4}, {"id": "inverter-level", "label": "inverter level", "confidence": 0.72, "tier": 2, "is_free_standing": true, "head_word": "level", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 4}, {"id": "level-control-system", "label": "level control system", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "system", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 3}, {"id": "set-points", "label": "set points", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "points", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 3}, {"id": "plant-level", "label": "plant level", "confidence": 0.71, "tier": 2, "is_free_standing": true, "head_word": "level", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 3}, {"id": "source-converter", "label": "source converter", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "converter", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 2}, {"id": "output-voltage", "label": "output voltage", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "ideal-current-source", "label": "ideal current source", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "source", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 2}, {"id": "sinusoidal-reference-voltage", "label": "sinusoidal reference voltage", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "pulse-width", "label": "pulse width", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "width", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "ideal-voltage-source", "label": "ideal voltage source", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "source", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 2}, {"id": "flow-from", "label": "flow from", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "from", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 2}, {"id": "current-sourced-converters", "label": "current sourced converters", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "converters", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 2}, {"id": "voltage-across", "label": "voltage across", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "across", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 2}, {"id": "source-the-interface", "label": "source the interface", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "interface", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 2}, {"id": "vscs-and-cscs", "label": "vscs and cscs", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "cscs", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 2}, {"id": "sinusoidal-waveform", "label": "sinusoidal waveform", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "waveform", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "switch-called", "label": "switch called", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "called", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 2}, {"id": "switching-frequency-leads", "label": "switching frequency leads", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "leads", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "around-the-switching", "label": "around the switching", "confidence": 0.7, "tier": 2, "is_free_standing": true, "head_word": "switching", "taught_in_slides": ["6JZsAHMHpvb"], "total_freq": 2}, {"id": "source-converters-pulse", "label": "source converters pulse", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "pulse", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "unit-controls-acting", "label": "unit controls acting", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "acting", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "timeframes-simple-response", "label": "timeframes simple response", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "response", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "included-switches-voltage", "label": "included switches voltage", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "switches-power-electronics", "label": "switches power electronics", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "electronics", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "csc-this-classification", "label": "csc this classification", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "classification", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "level-control-schemes", "label": "level control schemes", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "schemes", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "high-frequencies-let", "label": "high frequencies let", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "let", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "learn-the-basic", "label": "learn the basic", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "basic", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "interface-the-voltage", "label": "interface the voltage", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "inverter-controls-acting", "label": "inverter controls acting", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "acting", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "inverter-based-resources-basics", "label": "inverter-based resources basics", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "basics", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "plant-controls-along", "label": "plant controls along", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "along", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "generates-control-commands", "label": "generates control commands", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "commands", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "nested-loop-structure", "label": "nested loop structure", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "structure", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "coordinate-across-time", "label": "coordinate across time", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "time", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "power-electronic-switch", "label": "power electronic switch", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "switch", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "system-which-generates", "label": "system which generates", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "generates", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "basic-structure", "label": "basic structure", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "structure", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "output-filters-upon", "label": "output filters upon", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "upon", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "notice-the-differences", "label": "notice the differences", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "differences", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "detail-various-power", "label": "detail various power", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "power", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "flow-from-inverter-based", "label": "flow from inverter-based", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "inverter-based", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "faster-and-plant", "label": "faster and plant", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "plant", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "basics-and-operations", "label": "basics and operations", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "operations", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "ibr-plant-connection", "label": "ibr plant connection", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "connection", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "electronic-concepts-pertinent", "label": "electronic concepts pertinent", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "pertinent", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "voltage-magnitude-frequency", "label": "voltage magnitude frequency", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "frequency", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 1}, {"id": "three-phase-voltage-sourced", "label": "three-phase voltage sourced", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "sourced", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "concepts-including-switches", "label": "concepts including switches", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "switches", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "problem-the-individual", "label": "problem the individual", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "individual", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "plant-control-timeframes", "label": "plant control timeframes", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "timeframes", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "important-for-renewable", "label": "important for renewable", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "renewable", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "voltage-sourced-converter", "label": "voltage sourced converter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "converter", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "basic-diagram", "label": "basic diagram", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "diagram", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "reviewed-power-electronic", "label": "reviewed power electronic", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "electronic", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "sourced-converters-pulse", "label": "sourced converters pulse", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "pulse", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "how-the-individual", "label": "how the individual", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "individual", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "electronic-switch-features", "label": "electronic switch features", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "features", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "level-controls-schemes", "label": "level controls schemes", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "schemes", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "output-they-enable", "label": "output they enable", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "enable", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "topology-samples-let", "label": "topology samples let", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "let", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "power-grid", "label": "power grid", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "grid", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "transmission-system", "label": "transmission system", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "system", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "commands-for-inverter", "label": "commands for inverter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "inverter", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "voltage-source-converter", "label": "voltage source converter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "converter", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "primary-physical-structures", "label": "primary physical structures", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "structures", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "power-electronic-interface", "label": "power electronic interface", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "interface", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "outer-and-inner", "label": "outer and inner", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "inner", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "power-flow-from", "label": "power flow from", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "from", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "commutated-switch-called", "label": "commutated switch called", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "called", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "electronic-concepts-including", "label": "electronic concepts including", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "including", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "inner-control-pulse", "label": "inner control pulse", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "pulse", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "current-sources-recall", "label": "current sources recall", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "recall", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 1}, {"id": "structure-and-operation", "label": "structure and operation", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "operation", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "interconnect-and-coordinate", "label": "interconnect and coordinate", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "coordinate", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "flow-from-ibrs", "label": "flow from ibrs", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "ibrs", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "including-switches-voltage", "label": "including switches voltage", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "regulate-voltage-magnitude", "label": "regulate voltage magnitude", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "magnitude", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 1}, {"id": "controllers-this-separation", "label": "controllers this separation", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "separation", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "input-into-controlled", "label": "input into controlled", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "controlled", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "controller-timeframes-simplifies", "label": "controller timeframes simplifies", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "simplifies", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "simple-response-times", "label": "simple response times", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "times", "taught_in_slides": ["5q1PTTjK3aS"], "total_freq": 1}, {"id": "energy-flow-from", "label": "energy flow from", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "from", "taught_in_slides": ["5zBRyvxOwou"], "total_freq": 1}, {"id": "current-source-converter", "label": "current source converter", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "converter", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "various-power-electronic", "label": "various power electronic", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "electronic", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "two-level-three-phase-voltage", "label": "two-level three-phase voltage", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "voltage", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "grid-their-function", "label": "grid their function", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "function", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 1}, {"id": "phase-locked-loop", "label": "phase locked loop", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "loop", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "vsc-topology-samples", "label": "vsc topology samples", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "samples", "taught_in_slides": ["64VkQoxpjPi"], "total_freq": 1}, {"id": "features-are-critically", "label": "features are critically", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "critically", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "integration-with-traditional", "label": "integration with traditional", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "traditional", "taught_in_slides": ["66RtiTQPuzj"], "total_freq": 1}, {"id": "recall-that-power", "label": "recall that power", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "power", "taught_in_slides": ["6j4NfYacv8d"], "total_freq": 1}, {"id": "source-converters-vscs", "label": "source converters vscs", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "vscs", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "source-converters-cscs", "label": "source converters cscs", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "cscs", "taught_in_slides": ["6MvgELbfFIH"], "total_freq": 1}, {"id": "across-time-scales", "label": "across time scales", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "scales", "taught_in_slides": ["6ps7ro4Er5o"], "total_freq": 1}, {"id": "pwm-and-phase", "label": "pwm and phase", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "phase", "taught_in_slides": ["6eVptVTR2Lx"], "total_freq": 1}, {"id": "controllable-switch-called", "label": "controllable switch called", "confidence": 0.49, "tier": 3, "is_free_standing": true, "head_word": "called", "taught_in_slides": ["5uUiVx1gsqw"], "total_freq": 1}, {"id": "voltage", "label": "voltage", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "voltage", "taught_in_slides": ["6KhIqryeG83", "6j4NfYacv8d", "6JZsAHMHpvb"], "total_freq": 21}, {"id": "level", "label": "level", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "level", "taught_in_slides": ["6eVptVTR2Lx", "5q1PTTjK3aS"], "total_freq": 9}, {"id": "grid", "label": "grid", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "grid", "taught_in_slides": ["5zBRyvxOwou", "6KhIqryeG83", "6j4NfYacv8d"], "total_freq": 9}, {"id": "power", "label": "power", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "power", "taught_in_slides": ["6ps7ro4Er5o", "5zBRyvxOwou", "5uUiVx1gsqw", "66RtiTQPuzj"], "total_freq": 10}, {"id": "output", "label": "output", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "output", "taught_in_slides": ["6KhIqryeG83", "6JZsAHMHpvb"], "total_freq": 6}, {"id": "current", "label": "current", "confidence": 0.91, "tier": 1, "is_free_standing": false, "head_word": "current", "taught_in_slides": ["6KhIqryeG83", "5uUiVx1gsqw", "6j4NfYacv8d"], "total_freq": 11}], "prereq_edges": [{"from": "inverter-and-plant", "to": "inverter-level", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "level-control-system", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "plant", "confidence": 0.9}, {"from": "inverter-and-plant", "to": "plant-level", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "set-points", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "individual-inverter", "confidence": 0.9}, {"from": "inverter-and-plant", "to": "controller", "confidence": 0.9}, {"from": "inverter-and-plant", "to": "nested-loop-structure", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "outer-and-inner", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "inner-control-pulse", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "pwm-and-phase", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "phase-locked-loop", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "system-which-generates", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "generates-control-commands", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "commands-for-inverter", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "inverter-level", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "level-control-system", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "plant", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "plant-level", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "set-points", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "individual-inverter", "confidence": 0.9}, {"from": "pulse-width-modulation", "to": "controller", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "nested-loop-structure", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "outer-and-inner", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "inner-control-pulse", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "pwm-and-phase", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "phase-locked-loop", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "system-which-generates", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "generates-control-commands", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "commands-for-inverter", "confidence": 0.65}, {"from": "plant", "to": "plant-control-timeframes", "confidence": 0.65}, {"from": "plant", "to": "timeframes-simple-response", "confidence": 0.65}, {"from": "plant", "to": "simple-response-times", "confidence": 0.65}, {"from": "plant", "to": "notice-the-differences", "confidence": 0.65}, {"from": "plant", "to": "controllers-this-separation", "confidence": 0.65}, {"from": "plant", "to": "controller-timeframes-simplifies", "confidence": 0.65}, {"from": "plant", "to": "problem-the-individual", "confidence": 0.65}, {"from": "plant", "to": "level-control-schemes", "confidence": 0.65}, {"from": "plant", "to": "unit-controls-acting", "confidence": 0.65}, {"from": "plant", "to": "faster-and-plant", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "plant-control-timeframes", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "timeframes-simple-response", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "simple-response-times", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "notice-the-differences", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "controllers-this-separation", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "controller-timeframes-simplifies", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "problem-the-individual", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "level-control-schemes", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "unit-controls-acting", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "faster-and-plant", "confidence": 0.65}, {"from": "controller", "to": "plant-control-timeframes", "confidence": 0.65}, {"from": "controller", "to": "timeframes-simple-response", "confidence": 0.65}, {"from": "controller", "to": "simple-response-times", "confidence": 0.65}, {"from": "controller", "to": "notice-the-differences", "confidence": 0.65}, {"from": "controller", "to": "controllers-this-separation", "confidence": 0.65}, {"from": "controller", "to": "controller-timeframes-simplifies", "confidence": 0.65}, {"from": "controller", "to": "problem-the-individual", "confidence": 0.65}, {"from": "controller", "to": "level-control-schemes", "confidence": 0.65}, {"from": "controller", "to": "unit-controls-acting", "confidence": 0.65}, {"from": "controller", "to": "faster-and-plant", "confidence": 0.65}, {"from": "how", "to": "power-electronic", "confidence": 0.65}, {"from": "how", "to": "voltage-source", "confidence": 0.65}, {"from": "how", "to": "source-converters", "confidence": 0.65}, {"from": "how", "to": "switches", "confidence": 0.65}, {"from": "how", "to": "power-electronic-converters", "confidence": 0.65}, {"from": "how", "to": "power-electronic-switches", "confidence": 0.65}, {"from": "how", "to": "voltage-source-converters", "confidence": 0.65}, {"from": "power-electronic", "to": "switch-called", "confidence": 0.65}, {"from": "power-electronic", "to": "switches-power-electronics", "confidence": 0.65}, {"from": "power-electronic", "to": "input-into-controlled", "confidence": 0.65}, {"from": "power-electronic", "to": "output-they-enable", "confidence": 0.65}, {"from": "power-electronic", "to": "high-frequencies-let", "confidence": 0.65}, {"from": "power-electronic", "to": "commutated-switch-called", "confidence": 0.65}, {"from": "power-electronic", "to": "controllable-switch-called", "confidence": 0.65}, {"from": "power-electronic", "to": "power-electronic-switch", "confidence": 0.65}, {"from": "power-electronic", "to": "electronic-switch-features", "confidence": 0.65}, {"from": "power-electronic", "to": "features-are-critically", "confidence": 0.65}, {"from": "power-electronic", "to": "important-for-renewable", "confidence": 0.65}, {"from": "switches", "to": "switch-called", "confidence": 0.65}, {"from": "switches", "to": "switches-power-electronics", "confidence": 0.65}, {"from": "switches", "to": "input-into-controlled", "confidence": 0.65}, {"from": "switches", "to": "output-they-enable", "confidence": 0.65}, {"from": "switches", "to": "high-frequencies-let", "confidence": 0.65}, {"from": "switches", "to": "commutated-switch-called", "confidence": 0.65}, {"from": "switches", "to": "controllable-switch-called", "confidence": 0.65}, {"from": "switches", "to": "power-electronic-switch", "confidence": 0.65}, {"from": "switches", "to": "electronic-switch-features", "confidence": 0.65}, {"from": "switches", "to": "features-are-critically", "confidence": 0.65}, {"from": "switches", "to": "important-for-renewable", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "switch-called", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "switches-power-electronics", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "input-into-controlled", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "output-they-enable", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "high-frequencies-let", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "commutated-switch-called", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "controllable-switch-called", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "power-electronic-switch", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "electronic-switch-features", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "features-are-critically", "confidence": 0.65}, {"from": "power-electronic-switches", "to": "important-for-renewable", "confidence": 0.65}, {"from": "voltage-source", "to": "source", "confidence": 0.9}, {"from": "voltage-source", "to": "current-source", "confidence": 0.9}, {"from": "voltage-source", "to": "ideal-voltage-source", "confidence": 0.65}, {"from": "voltage-source", "to": "ideal-current-source", "confidence": 0.65}, {"from": "voltage-source", "to": "source-the-interface", "confidence": 0.65}, {"from": "voltage-source", "to": "voltage-across", "confidence": 0.65}, {"from": "voltage-source", "to": "current-sources-recall", "confidence": 0.65}, {"from": "voltage-source", "to": "recall-that-power", "confidence": 0.65}, {"from": "voltage-source", "to": "grid-their-function", "confidence": 0.65}, {"from": "voltage-source", "to": "regulate-voltage-magnitude", "confidence": 0.65}, {"from": "voltage-source", "to": "voltage-magnitude-frequency", "confidence": 0.65}, {"from": "power-electronic", "to": "source", "confidence": 0.65}, {"from": "power-electronic", "to": "current-source", "confidence": 0.65}, {"from": "power-electronic", "to": "ideal-voltage-source", "confidence": 0.65}, {"from": "power-electronic", "to": "ideal-current-source", "confidence": 0.65}, {"from": "power-electronic", "to": "source-the-interface", "confidence": 0.65}, {"from": "power-electronic", "to": "voltage-across", "confidence": 0.65}, {"from": "power-electronic", "to": "current-sources-recall", "confidence": 0.65}, {"from": "power-electronic", "to": "recall-that-power", "confidence": 0.65}, {"from": "power-electronic", "to": "grid-their-function", "confidence": 0.65}, {"from": "power-electronic", "to": "regulate-voltage-magnitude", "confidence": 0.65}, {"from": "power-electronic", "to": "voltage-magnitude-frequency", "confidence": 0.65}, {"from": "voltage-and-current", "to": "source", "confidence": 0.65}, {"from": "voltage-and-current", "to": "voltage-source", "confidence": 0.65}, {"from": "voltage-and-current", "to": "current-source", "confidence": 0.65}, {"from": "voltage-and-current", "to": "ideal-voltage-source", "confidence": 0.65}, {"from": "voltage-and-current", "to": "ideal-current-source", "confidence": 0.65}, {"from": "voltage-and-current", "to": "source-the-interface", "confidence": 0.65}, {"from": "voltage-and-current", "to": "power-electronic", "confidence": 0.65}, {"from": "voltage-and-current", "to": "voltage-across", "confidence": 0.65}, {"from": "voltage-and-current", "to": "current-sources-recall", "confidence": 0.65}, {"from": "voltage-and-current", "to": "recall-that-power", "confidence": 0.65}, {"from": "voltage-and-current", "to": "power-electronic-converters", "confidence": 0.65}, {"from": "voltage-and-current", "to": "grid-their-function", "confidence": 0.65}, {"from": "voltage-and-current", "to": "regulate-voltage-magnitude", "confidence": 0.65}, {"from": "voltage-and-current", "to": "voltage-magnitude-frequency", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "source", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "current-source", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "ideal-voltage-source", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "ideal-current-source", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "source-the-interface", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "voltage-across", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "current-sources-recall", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "recall-that-power", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "grid-their-function", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "regulate-voltage-magnitude", "confidence": 0.65}, {"from": "power-electronic-converters", "to": "voltage-magnitude-frequency", "confidence": 0.65}, {"from": "source", "to": "vscs-and-cscs", "confidence": 0.65}, {"from": "source", "to": "source-converter", "confidence": 0.65}, {"from": "source", "to": "vsc", "confidence": 0.65}, {"from": "source", "to": "source-converters-vscs", "confidence": 0.65}, {"from": "source", "to": "source-converters-cscs", "confidence": 0.65}, {"from": "source", "to": "primary-physical-structures", "confidence": 0.65}, {"from": "source", "to": "power-electronic-interface", "confidence": 0.65}, {"from": "source", "to": "interface-the-voltage", "confidence": 0.65}, {"from": "source", "to": "voltage-source-converter", "confidence": 0.65}, {"from": "source", "to": "current-source-converter", "confidence": 0.65}, {"from": "source", "to": "csc-this-classification", "confidence": 0.65}, {"from": "current-source", "to": "vscs-and-cscs", "confidence": 0.65}, {"from": "current-source", "to": "source-converter", "confidence": 0.65}, {"from": "current-source", "to": "vsc", "confidence": 0.65}, {"from": "current-source", "to": "source-converters-vscs", "confidence": 0.65}, {"from": "current-source", "to": "source-converters-cscs", "confidence": 0.65}, {"from": "current-source", "to": "primary-physical-structures", "confidence": 0.65}, {"from": "current-source", "to": "power-electronic-interface", "confidence": 0.65}, {"from": "current-source", "to": "interface-the-voltage", "confidence": 0.65}, {"from": "current-source", "to": "voltage-source-converter", "confidence": 0.65}, {"from": "current-source", "to": "current-source-converter", "confidence": 0.65}, {"from": "current-source", "to": "csc-this-classification", "confidence": 0.65}, {"from": "voltage-source", "to": "vscs-and-cscs", "confidence": 0.65}, {"from": "voltage-source", "to": "source-converter", "confidence": 0.65}, {"from": "voltage-source", "to": "vsc", "confidence": 0.65}, {"from": "voltage-source", "to": "source-converters-vscs", "confidence": 0.65}, {"from": "voltage-source", "to": "source-converters-cscs", "confidence": 0.65}, {"from": "voltage-source", "to": "primary-physical-structures", "confidence": 0.65}, {"from": "voltage-source", "to": "power-electronic-interface", "confidence": 0.65}, {"from": "voltage-source", "to": "interface-the-voltage", "confidence": 0.65}, {"from": "voltage-source", "to": "voltage-source-converter", "confidence": 0.65}, {"from": "voltage-source", "to": "current-source-converter", "confidence": 0.65}, {"from": "voltage-source", "to": "csc-this-classification", "confidence": 0.65}, {"from": "source-converters", "to": "source", "confidence": 0.65}, {"from": "source-converters", "to": "current-source", "confidence": 0.65}, {"from": "source-converters", "to": "vscs-and-cscs", "confidence": 0.65}, {"from": "source-converters", "to": "source-converter", "confidence": 0.65}, {"from": "source-converters", "to": "vsc", "confidence": 0.65}, {"from": "source-converters", "to": "source-converters-vscs", "confidence": 0.65}, {"from": "source-converters", "to": "source-converters-cscs", "confidence": 0.65}, {"from": "source-converters", "to": "primary-physical-structures", "confidence": 0.65}, {"from": "source-converters", "to": "power-electronic-interface", "confidence": 0.65}, {"from": "source-converters", "to": "interface-the-voltage", "confidence": 0.65}, {"from": "source-converters", "to": "voltage-source-converter", "confidence": 0.65}, {"from": "source-converters", "to": "current-source-converter", "confidence": 0.65}, {"from": "source-converters", "to": "csc-this-classification", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "source", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "current-source", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "vscs-and-cscs", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "source-converter", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "vsc", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "source-converters-vscs", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "source-converters-cscs", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "primary-physical-structures", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "power-electronic-interface", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "interface-the-voltage", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "voltage-source-converter", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "current-source-converter", "confidence": 0.65}, {"from": "voltage-source-converters", "to": "csc-this-classification", "confidence": 0.65}, {"from": "current-source-converters", "to": "source", "confidence": 0.65}, {"from": "current-source-converters", "to": "current-source", "confidence": 0.65}, {"from": "current-source-converters", "to": "voltage-source", "confidence": 0.65}, {"from": "current-source-converters", "to": "vscs-and-cscs", "confidence": 0.65}, {"from": "current-source-converters", "to": "source-converters", "confidence": 0.65}, {"from": "current-source-converters", "to": "source-converter", "confidence": 0.65}, {"from": "current-source-converters", "to": "vsc", "confidence": 0.65}, {"from": "current-source-converters", "to": "voltage-source-converters", "confidence": 0.65}, {"from": "current-source-converters", "to": "source-converters-vscs", "confidence": 0.65}, {"from": "current-source-converters", "to": "source-converters-cscs", "confidence": 0.65}, {"from": "current-source-converters", "to": "primary-physical-structures", "confidence": 0.65}, {"from": "current-source-converters", "to": "power-electronic-interface", "confidence": 0.65}, {"from": "current-source-converters", "to": "interface-the-voltage", "confidence": 0.65}, {"from": "current-source-converters", "to": "voltage-source-converter", "confidence": 0.65}, {"from": "current-source-converters", "to": "current-source-converter", "confidence": 0.65}, {"from": "current-source-converters", "to": "csc-this-classification", "confidence": 0.65}, {"from": "vsc", "to": "vsc-topology-samples", "confidence": 0.65}, {"from": "vsc", "to": "topology-samples-let", "confidence": 0.65}, {"from": "vsc", "to": "two-level-three-phase-voltage", "confidence": 0.65}, {"from": "vsc", "to": "three-phase-voltage-sourced", "confidence": 0.65}, {"from": "vsc", "to": "voltage-sourced-converter", "confidence": 0.65}, {"from": "vsc", "to": "learn-the-basic", "confidence": 0.65}, {"from": "vsc", "to": "structure-and-operation", "confidence": 0.65}, {"from": "vsc", "to": "basic-structure", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "basics-and-operations", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "how-the-individual", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "inverter-and-plant", "to": "sourced-converters-pulse", "confidence": 0.65}, {"from": "voltage-and-current", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "voltage-and-current", "to": "individual-inverter", "confidence": 0.65}, {"from": "voltage-and-current", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "voltage-and-current", "to": "basics-and-operations", "confidence": 0.65}, {"from": "voltage-and-current", "to": "how-the-individual", "confidence": 0.65}, {"from": "voltage-and-current", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "voltage-and-current", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "voltage-and-current", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "voltage-and-current", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "voltage-and-current", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "voltage-and-current", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "voltage-and-current", "to": "sourced-converters-pulse", "confidence": 0.65}, {"from": "individual-inverter", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "individual-inverter", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "individual-inverter", "to": "basics-and-operations", "confidence": 0.65}, {"from": "individual-inverter", "to": "how-the-individual", "confidence": 0.65}, {"from": "individual-inverter", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "individual-inverter", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "individual-inverter", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "individual-inverter", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "individual-inverter", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "individual-inverter", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "individual-inverter", "to": "sourced-converters-pulse", "confidence": 0.65}, {"from": "how", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "how", "to": "individual-inverter", "confidence": 0.65}, {"from": "how", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "how", "to": "basics-and-operations", "confidence": 0.65}, {"from": "how", "to": "how-the-individual", "confidence": 0.65}, {"from": "how", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "how", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "how", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "how", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "how", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "how", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "how", "to": "sourced-converters-pulse", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "individual-inverter", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "basics-and-operations", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "how-the-individual", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "power-electronic-concepts", "to": "sourced-converters-pulse", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "individual-inverter", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "basics-and-operations", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "how-the-individual", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "converters-pulse-width", "to": "sourced-converters-pulse", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "basics-and-operations", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "how-the-individual", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "pulse-width-modulation", "to": "sourced-converters-pulse", "confidence": 0.65}, {"from": "modulation-and-output", "to": "current-sourced-converters", "confidence": 0.65}, {"from": "modulation-and-output", "to": "individual-inverter", "confidence": 0.65}, {"from": "modulation-and-output", "to": "inverter-based-resources-basics", "confidence": 0.65}, {"from": "modulation-and-output", "to": "basics-and-operations", "confidence": 0.65}, {"from": "modulation-and-output", "to": "how-the-individual", "confidence": 0.65}, {"from": "modulation-and-output", "to": "level-controls-schemes", "confidence": 0.65}, {"from": "modulation-and-output", "to": "inverter-controls-acting", "confidence": 0.65}, {"from": "modulation-and-output", "to": "reviewed-power-electronic", "confidence": 0.65}, {"from": "modulation-and-output", "to": "electronic-concepts-pertinent", "confidence": 0.65}, {"from": "modulation-and-output", "to": "integration-with-traditional", "confidence": 0.65}, {"from": "modulation-and-output", "to": "included-switches-voltage", "confidence": 0.65}, {"from": "modulation-and-output", "to": "sourced-converters-pulse", "confidence": 0.65}], "modifier_pairs": [{"modifier": "output-voltage", "target": "voltage"}, {"modifier": "included-switches-voltage", "target": "voltage"}, {"modifier": "interface-the-voltage", "target": "voltage"}, {"modifier": "sinusoidal-reference-voltage", "target": "voltage"}, {"modifier": "including-switches-voltage", "target": "voltage"}, {"modifier": "two-level-three-phase-voltage", "target": "voltage"}, {"modifier": "voltage-source-converter", "target": "source-converter"}, {"modifier": "current-source-converter", "target": "source-converter"}, {"modifier": "voltage-and-current", "target": "current"}, {"modifier": "modulation-and-output", "target": "output"}, {"modifier": "plant-level", "target": "level"}, {"modifier": "inverter-level", "target": "level"}, {"modifier": "detail-various-power", "target": "power"}, {"modifier": "recall-that-power", "target": "power"}, {"modifier": "faster-and-plant", "target": "plant"}, {"modifier": "inverter-and-plant", "target": "plant"}, {"modifier": "concepts-including-switches", "target": "switches"}, {"modifier": "power-electronic-switches", "target": "switches"}, {"modifier": "current-source", "target": "source"}, {"modifier": "voltage-source", "target": "source"}, {"modifier": "ideal-current-source", "target": "current-source"}, {"modifier": "ideal-voltage-source", "target": "voltage-source"}, {"modifier": "voltage-source-converters", "target": "source-converters"}, {"modifier": "current-source-converters", "target": "source-converters"}, {"modifier": "converters-pulse-width", "target": "pulse-width"}, {"modifier": "reviewed-power-electronic", "target": "power-electronic"}, {"modifier": "various-power-electronic", "target": "power-electronic"}, {"modifier": "power-flow-from", "target": "flow-from"}, {"modifier": "energy-flow-from", "target": "flow-from"}, {"modifier": "power-grid", "target": "grid"}, {"modifier": "commutated-switch-called", "target": "switch-called"}, {"modifier": "controllable-switch-called", "target": "switch-called"}]}]}`;
const DATA = JSON.parse(RAW_DATA);
const COURSE = DATA.primary;
const FEDERATION = DATA.federation || [];
// All courses (primary + federation) in one list — useful for ranking/search
const ALL_COURSES = [COURSE, ...FEDERATION];

// ════════════════════════════════════════════════════════════════
// GRAPH PRIMITIVES — stand-in for SPARQL queries against the RDF.
// In a federated deployment these become SPARQL `SELECT` against
// the actual triple store; the structure of the calls remains
// identical (find concepts → traverse to slides → return matching).
// ════════════════════════════════════════════════════════════════

const conceptById = (id) => COURSE.concepts.find(c => c.id === id);
const slideById = (id) => COURSE.slides.find(s => s.id === id);
const sceneById = (id) => COURSE.scenes.find(s => s.id === id);

const conceptsForSlide = (slideId) =>
  COURSE.concepts.filter(c => c.taught_in_slides.includes(slideId));

const prereqsOfSlide = (slideId) => {
  const slideConceptIds = new Set(conceptsForSlide(slideId).map(c => c.id));
  const prereqs = new Map();
  COURSE.prereq_edges.forEach(e => {
    if (slideConceptIds.has(e.to) && !slideConceptIds.has(e.from)) {
      prereqs.set(e.from, e);
    }
  });
  return Array.from(prereqs.values());
};

// Modifier group: given a head concept, find all concepts that modify it.
// Equivalent SPARQL:
//    SELECT ?modifier WHERE { ?modifier fxk:modifierOf <target> }
const modifiersOf = (targetId) =>
  COURSE.modifier_pairs
    .filter(p => p.target === targetId)
    .map(p => conceptById(p.modifier))
    .filter(Boolean);

// What is this concept a modifier of? (zero or one)
const targetOf = (modifierId) => {
  const p = COURSE.modifier_pairs.find(p => p.modifier === modifierId);
  return p ? conceptById(p.target) : null;
};

// ────────────────────────────────────────────────────────────────
// FEDERATION PRIMITIVES — work across primary + peer courses.
// 
// In a real Context Graphs deployment, these would issue
// federated SPARQL via discover_context() and aggregate results
// from each pod's named graphs. Here we operate in-memory across
// pre-loaded peer payloads, which preserves the same call shape.
// ────────────────────────────────────────────────────────────────

// Search ALL courses for concepts whose label matches a query term.
// Returns an array of { concept, course } pairs ranked by match strength.
const federatedConceptSearch = (queryText, opts = {}) => {
  const limit = opts.limit ?? 10;
  const lower = queryText.toLowerCase();
  const terms = lower.split(/\s+/).filter(t => t.length > 2);
  const results = [];
  for (const course of ALL_COURSES) {
    for (const c of course.concepts) {
      const label = c.label.toLowerCase();
      let score = 0;
      // Exact label match wins
      if (label === lower) score += 10;
      // Whole-word phrase appearance
      else if (label.includes(lower)) score += 6;
      // Term-by-term match
      for (const t of terms) {
        if (label.includes(t)) score += 2;
        if (c.head_word && c.head_word.toLowerCase() === t) score += 1;
      }
      if (score > 0) {
        results.push({ concept: c, course, score });
      }
    }
  }
  results.sort((a, b) => b.score - a.score || (b.concept.confidence - a.concept.confidence));
  return results.slice(0, limit);
};

// Find slides across federation where a given concept (by label) is taught.
// Used by chat to cite cross-course context.
const federatedSlidesForConceptLabel = (label) => {
  const lower = label.toLowerCase();
  const hits = [];
  for (const course of ALL_COURSES) {
    const matchingConcepts = course.concepts.filter(c => c.label.toLowerCase() === lower);
    for (const c of matchingConcepts) {
      for (const slideId of c.taught_in_slides) {
        const slide = course.slides.find(s => s.id === slideId);
        if (slide) hits.push({ slide, concept: c, course });
      }
    }
  }
  return hits;
};

const firstSlideForConcept = (() => {
  const cache = {};
  return (conceptId) => {
    if (conceptId in cache) return cache[conceptId];
    const concept = conceptById(conceptId);
    if (!concept || concept.taught_in_slides.length === 0) return cache[conceptId] = null;
    const slideIndex = (sid) => COURSE.slides.findIndex(s => s.id === sid);
    const sorted = [...concept.taught_in_slides].sort((a, b) => slideIndex(a) - slideIndex(b));
    return cache[conceptId] = sorted[0];
  };
})();

// ════════════════════════════════════════════════════════════════
// GRAPH-BASED RETRIEVAL (replaces v0.2 term-overlap)
// ════════════════════════════════════════════════════════════════

// Cheap concept lookup: find concepts whose label contains any of the
// content tokens in the question. In a SPARQL backend this becomes
// FILTER(REGEX) or full-text search via Lucene.
// findRelevantConcepts now federates across all loaded courses.
// Returns { c, course, score } records ranked by match strength so the
// downstream prompt builder can attribute concepts to their origin
// course when citing them.
function findRelevantConcepts(question, opts = {}) {
  const { topK = 8 } = opts;
  const q = question.toLowerCase();
  const qTokens = q.split(/\W+/).filter(t => t.length >= 4);
  if (qTokens.length === 0) return [];
  
  const scored = [];
  for (const course of ALL_COURSES) {
    for (const c of course.concepts) {
      let score = 0;
      const lower = c.label.toLowerCase();
      qTokens.forEach(t => {
        if (lower === t) score += 5;
        else if (lower.includes(t)) score += 2;
        else if (t.includes(lower) && lower.length >= 4) score += 1;
      });
      if (!c.is_free_standing) score *= 0.5;
      if (score > 0) scored.push({ c, course, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// Graph traversal: from concepts (each tagged with their course), expand
// to neighborhood within their respective courses. We don't currently do
// cross-course graph traversal — concept relationships are within a
// single course's graph — but we DO collect slides from all courses where
// the seed concepts appear.
function expandConceptNeighborhood(seeded, depth = 1) {
  const slides = [];
  const expanded = [...seeded];
  const seen = new Set(seeded.map(s => `${s.course.package.course_id}:${s.c.id}`));
  
  const enqueue = (c, course) => {
    if (!c) return;
    const k = `${course.package.course_id}:${c.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    expanded.push({ c, course });
  };
  
  seeded.forEach(({ c, course }) => {
    if (depth >= 1) {
      course.modifier_pairs
        .filter(p => p.target === c.id)
        .forEach(p => enqueue(course.concepts.find(x => x.id === p.modifier), course));
      const tgt = course.modifier_pairs.find(p => p.modifier === c.id);
      if (tgt) enqueue(course.concepts.find(x => x.id === tgt.target), course);
      course.prereq_edges
        .filter(e => e.to === c.id)
        .forEach(e => enqueue(course.concepts.find(x => x.id === e.from), course));
    }
  });
  
  expanded.forEach(({ c, course }) => {
    c.taught_in_slides.forEach(sid => {
      const slide = course.slides.find(s => s.id === sid);
      if (slide) slides.push({ slide, course });
    });
  });
  
  return { concepts: expanded, slides };
}

function buildGraphContext(question) {
  // 1. Federated concept search across all loaded courses
  const seedConcepts = findRelevantConcepts(question, { topK: 6 });
  
  // 2. Expand 1 hop within each concept's home course
  const { concepts: ctxConcepts, slides: ctxSlides } =
    expandConceptNeighborhood(seedConcepts, 1);
  
  // 3. Allocate citation slots per contributing course so peer-course
  // slides aren't crowded out by the primary. Without this, a primary
  // course with many matching slides will always fill the cap of 5
  // before any peer slide is cited — defeating the federation.
  // 
  // Strategy: bucket slides by course, each bucket internally ordered by
  // slide sequence, then round-robin pick to fill up to 5 total. Primary
  // course leads each round so it gets first dibs on slot 1.
  
  const courseOrder = (cid) => cid === COURSE.package.course_id ? 0 : 1;
  
  const seenKey = new Set();
  const buckets = new Map(); // course_id -> [{slide, course}]
  for (const item of ctxSlides) {
    const k = `${item.course.package.course_id}:${item.slide.id}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    const cid = item.course.package.course_id;
    if (!buckets.has(cid)) buckets.set(cid, []);
    buckets.get(cid).push(item);
  }
  
  // Sort each bucket by slide sequence_index
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.slide.sequence_index - b.slide.sequence_index);
  }
  
  // Order course IDs: primary first, then peers (alphabetical within peers
  // for determinism — could also be by seed strength)
  const orderedCourseIds = [...buckets.keys()].sort((a, b) => {
    const o = courseOrder(a) - courseOrder(b);
    return o !== 0 ? o : a.localeCompare(b);
  });
  
  // Round-robin pick up to 5 total
  const citedSlides = [];
  let round = 0;
  while (citedSlides.length < 5) {
    let pickedThisRound = false;
    for (const cid of orderedCourseIds) {
      const bucket = buckets.get(cid);
      if (bucket && bucket.length > round) {
        citedSlides.push(bucket[round]);
        pickedThisRound = true;
        if (citedSlides.length >= 5) break;
      }
    }
    if (!pickedThisRound) break;
    round++;
  }
  
  // 4. Fallback when no concepts matched: first 3 narrated slides
  // from the primary course only
  let finalCited = citedSlides;
  if (finalCited.length === 0) {
    finalCited = COURSE.slides
      .filter(s => s.transcript_combined.length > 50)
      .slice(0, 3)
      .map(s => ({ slide: s, course: COURSE }));
  }
  
  // Which courses contributed seed concepts? Used in the system prompt
  // to make the federation behavior legible to the user.
  const contributingCourses = [...new Set(seedConcepts.map(s => s.course.package.course_id))];
  
  return {
    seedConcepts,
    ctxConcepts: ctxConcepts.slice(0, 16),
    citedSlides: finalCited,
    retrievalKind: seedConcepts.length > 0 ? 'graph' : 'fallback',
    contributingCourses,
  };
}

// ════════════════════════════════════════════════════════════════
// CHAT WITH THE COURSE
// ════════════════════════════════════════════════════════════════

async function askClaude(question, history) {
  const { seedConcepts, ctxConcepts, citedSlides, retrievalKind, contributingCourses } = buildGraphContext(question);
  
  // citedSlides is now [{slide, course}] — render with course attribution
  const slideBlocks = citedSlides.map(({ slide, course }) => {
    const slideConcepts = slide.concept_ids
      .map(id => course.concepts.find(c => c.id === id))
      .filter(c => c && c.is_free_standing)
      .slice(0, 6)
      .map(c => c.label)
      .join(', ');
    const coursePrefix = course === COURSE
      ? ''
      : `[${course.package.course_label}] `;
    return [
      `${coursePrefix}[Slide §${slide.sequence_index + 1}: ${slide.title}] (course: ${course.package.course_label}, id: ${slide.id})`,
      slideConcepts ? `  Free-standing concepts: ${slideConcepts}` : '',
      slide.transcript_combined ? `  Transcript: ${slide.transcript_combined}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  
  // ctxConcepts is now [{c, course}] — show with course attribution where relevant
  const conceptList = ctxConcepts
    .filter(({ c }) => c.is_free_standing)
    .map(({ c, course }) => course === COURSE
      ? c.label
      : `${c.label} (${course.package.course_label})`)
    .join('; ');
  
  // Federation status: distinguish "answered from primary" vs "drew on peer course"
  const peerCourses = contributingCourses.filter(cid => cid !== COURSE.package.course_id);
  let federationStatus;
  if (seedConcepts.length === 0) {
    federationStatus = `No matching concepts found in any loaded course graph (primary: ${COURSE.package.course_label}, peers: ${FEDERATION.map(f => f.package.course_label).join(', ') || 'none'}). Falling back to first slides of the primary course.`;
  } else if (peerCourses.length > 0) {
    const peerNames = FEDERATION
      .filter(f => peerCourses.includes(f.package.course_id))
      .map(f => f.package.course_label)
      .join(', ');
    federationStatus = `Drew on federation peer course(s): ${peerNames}. Cite peer-course slides with their course label so the user knows where the answer comes from.`;
  } else {
    federationStatus = `All matches from primary course (${COURSE.package.course_label}). Federation peers (${FEDERATION.map(f => f.package.course_label).join(', ') || 'none'}) did not have matching concepts.`;
  }
  
  const systemPrompt = `You are a tutor with access to a federation of power-systems course graphs.

Primary course: "${COURSE.package.title}" — ${COURSE.scenes.length} scenes, ${COURSE.slides.length} slides, ${COURSE.stats.audio_seconds.toFixed(0)}s narration.
${FEDERATION.length > 0 ? `Federation peers loaded: ${FEDERATION.map(f => `"${f.package.title}" (${f.slides.length} slides)`).join(', ')}.` : 'No federation peers loaded.'}

Your knowledge is strictly limited to the course content retrieved below — do not invent material that isn't there.

Retrieval (${retrievalKind}):
  ${seedConcepts.length} seed concept(s) matched: ${seedConcepts.map(({ c, course }) => course === COURSE ? c.label : `${c.label} [${course.package.course_label}]`).join(', ') || '(none)'}
  Expanded to ${ctxConcepts.length} related concepts and ${citedSlides.length} cited slide(s).

Federation status: ${federationStatus}

Concepts in retrieved neighborhood: ${conceptList}.

Cited slide content:
─────────────────────────────────────────
${slideBlocks}
─────────────────────────────────────────

When citing a slide that comes from a federation peer, prefix with the course label, e.g. [Lesson 2: Inverter Basics]. When citing a primary-course slide just use the slide title in brackets, e.g. [Voltage Control]. Answer in plain prose, 2-4 short paragraphs unless depth is requested. If the retrieved material doesn't address the question, say so honestly rather than inventing.`;
  
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: question }
  ];
  
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    })
  });
  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  return { text, citedSlides, seedConcepts, retrievalKind, contributingCourses };
}

// ════════════════════════════════════════════════════════════════
// CONCEPT-AWARE TRANSCRIPT
// ════════════════════════════════════════════════════════════════

function HighlightedTranscript({ text, conceptIds, onConceptClick }) {
  const concepts = conceptIds
    .map(id => conceptById(id))
    .filter(Boolean)
    .sort((a, b) => b.label.length - a.label.length);
  
  const ranges = [];
  const lower = text.toLowerCase();
  concepts.forEach(c => {
    const phrase = c.label.toLowerCase();
    let i = 0;
    while ((i = lower.indexOf(phrase, i)) !== -1) {
      const end = i + phrase.length;
      const overlaps = ranges.some(r => !(end <= r.start || i >= r.end));
      if (!overlaps) {
        const before = i === 0 ? ' ' : text[i - 1];
        const after = end >= text.length ? ' ' : text[end];
        if (!/[\w]/.test(before) && !/[\w]/.test(after)) {
          ranges.push({ start: i, end, conceptId: c.id, isFreeStanding: c.is_free_standing });
        }
      }
      i = end;
    }
  });
  ranges.sort((a, b) => a.start - b.start);
  
  const parts = [];
  let cursor = 0;
  ranges.forEach((r, idx) => {
    if (cursor < r.start) parts.push({ kind: 'text', text: text.slice(cursor, r.start), key: `t${idx}` });
    parts.push({
      kind: 'concept',
      text: text.slice(r.start, r.end),
      conceptId: r.conceptId,
      isFreeStanding: r.isFreeStanding,
      key: `c${idx}`,
    });
    cursor = r.end;
  });
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor), key: 'tend' });
  
  return (
    <span style={{ lineHeight: 1.7 }}>
      {parts.map(p =>
        p.kind === 'concept' ? (
          <button
            key={p.key}
            onClick={() => onConceptClick && onConceptClick(p.conceptId)}
            style={{
              background: p.isFreeStanding ? 'rgba(193, 80, 28, 0.10)' : 'transparent',
              border: 'none',
              borderBottom: p.isFreeStanding ? '1.5px solid #c1501c' : '1px dotted rgba(26, 35, 50, 0.4)',
              padding: '0 1px',
              margin: 0,
              font: 'inherit',
              color: '#1a2332',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            title={p.isFreeStanding ? 'free-standing concept' : 'bare topic word — click to see modifiers'}
          >
            {p.text}
          </button>
        ) : (
          <span key={p.key}>{p.text}</span>
        )
      )}
    </span>
  );
}

// ════════════════════════════════════════════════════════════════
// CONCEPT NETWORK — free-standing concepts only
// ════════════════════════════════════════════════════════════════

function ConceptNetwork({ selectedSlide, selectedConcept, onConceptClick, hoveredConcept, setHoveredConcept }) {
  const width = 480, height = 380;
  
  // Stable position per concept id. Computed in two phases:
  //  1. Deterministic seed — hash the id for angle, rank for ring (so
  //     "important" concepts cluster near the center, with the seed being
  //     reproducible across reloads).
  //  2. Force relaxation — apply a few iterations of repulsion between all
  //     positioned nodes plus weak attraction back to the seed point.
  //     This spreads nodes that the deterministic hash placed too close
  //     together, while keeping the overall structure recognizable.
  //
  // Positions are computed once. Selection changes never re-position.
  const positions = useMemo(() => {
    const cx = width / 2, cy = height / 2;
    
    // === Phase 1: deterministic seed positions ===
    const ranked = [...COURSE.concepts]
      .sort((a, b) => (b.confidence * Math.log(b.total_freq + 1)) - (a.confidence * Math.log(a.total_freq + 1)));
    const rankOf = {};
    ranked.forEach((c, i) => { rankOf[c.id] = i; });
    
    // Only compute positions for nodes that could plausibly render —
    // top free-standing + bare topics + anyone who participates in a
    // modifier-of relation (so selection-revealed modifiers always have
    // positions, regardless of their global rank).
    const modifierParticipants = new Set();
    COURSE.modifier_pairs.forEach(p => {
      modifierParticipants.add(p.modifier);
      modifierParticipants.add(p.target);
    });
    
    const placedConcepts = COURSE.concepts
      .filter(c =>
        c.is_free_standing ||
        rankOf[c.id] < 60 ||
        modifierParticipants.has(c.id)
      )
      .sort((a, b) => rankOf[a.id] - rankOf[b.id]);
    
    const nodes = placedConcepts.map(c => {
      let h = 0;
      for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const baseAngle = (h % 10000) / 10000 * Math.PI * 2;
      const r_jitter = (h >> 10) % 20;
      const rank = rankOf[c.id] ?? 100;
      const ringIdx = rank < 6 ? 0 : rank < 16 ? 1 : 2;
      const radius = [48, 108, 162][ringIdx] + r_jitter;
      return {
        id: c.id,
        x: cx + Math.cos(baseAngle) * radius,
        y: cy + Math.sin(baseAngle) * radius,
        anchorX: cx + Math.cos(baseAngle) * radius,  // weak pull-back
        anchorY: cy + Math.sin(baseAngle) * radius,
        ringIdx,
      };
    });
    
    // === Phase 2: force relaxation ===
    // Anisotropic repulsion: labels are wider than they are tall, so we
    // repel more strongly along x than y. This produces vertical stacks
    // of nodes (with labels not colliding horizontally) rather than
    // tight circular clusters.
    const minDistX = 90;   // generous horizontal spacing for labels
    const minDistY = 38;   // tighter vertical, label heights are small
    const repulsion = 1.2;
    const anchorPull = 0.025;
    
    for (let iter = 0; iter < 150; iter++) {
      const cooling = 1 - (iter / 150) * 0.7;
      
      for (let i = 0; i < nodes.length; i++) {
        let fx = 0, fy = 0;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          // Compare against ellipse: |dx|/minDistX + |dy|/minDistY < 1
          const overlapX = Math.max(0, minDistX - Math.abs(dx)) / minDistX;
          const overlapY = Math.max(0, minDistY - Math.abs(dy)) / minDistY;
          const overlap = Math.min(overlapX, overlapY);
          if (overlap > 0) {
            const distSq = dx * dx + dy * dy;
            const dist = Math.sqrt(Math.max(distSq, 0.01));
            const force = overlap * repulsion;
            // Direction: unit vector from j to i, but biased to push x more
            const ux = dx / dist;
            const uy = dy / dist;
            fx += ux * force * minDistX * 0.5;
            fy += uy * force * minDistY * 0.5;
          }
        }
        fx += (nodes[i].anchorX - nodes[i].x) * anchorPull;
        fy += (nodes[i].anchorY - nodes[i].y) * anchorPull;
        
        nodes[i].x += fx * cooling;
        nodes[i].y += fy * cooling;
        
        // Soft boundary
        const marginX = 28, marginY = 28;
        if (nodes[i].x < marginX) nodes[i].x += (marginX - nodes[i].x) * 0.5;
        if (nodes[i].x > width - marginX) nodes[i].x -= (nodes[i].x - (width - marginX)) * 0.5;
        if (nodes[i].y < marginY) nodes[i].y += (marginY - nodes[i].y) * 0.5;
        if (nodes[i].y > height - marginY - 10) nodes[i].y -= (nodes[i].y - (height - marginY - 10)) * 0.5;
      }
    }
    
    nodes.forEach(n => {
      n.x = Math.max(20, Math.min(width - 20, n.x));
      n.y = Math.max(20, Math.min(height - 20, n.y));
    });
    
    const pos = {};
    nodes.forEach(n => {
      pos[n.id] = { x: n.x, y: n.y, ringIdx: n.ringIdx };
    });
    return pos;
  }, []);
  
  // Which concepts to actually render. This list CAN change with selection,
  // but it doesn't move anyone — it just adds/removes nodes.
  const focusConcepts = useMemo(() => {
    const slideConceptIds = selectedSlide
      ? new Set(slideById(selectedSlide)?.concept_ids || [])
      : null;
    const ranked = [...COURSE.concepts]
      .filter(c => c.is_free_standing)
      .filter(c => c.tier <= 2 || (slideConceptIds && slideConceptIds.has(c.id)))
      .sort((a, b) => (b.confidence * Math.log(b.total_freq + 1)) - (a.confidence * Math.log(a.total_freq + 1)))
      .slice(0, 20);
    
    // Selection always wins inclusion — bare topics, off-list tier-3, anything.
    if (selectedConcept) {
      const sel = conceptById(selectedConcept);
      if (sel && !ranked.find(c => c.id === selectedConcept)) {
        ranked.push(sel);
      }
    }
    return ranked;
  }, [selectedSlide, selectedConcept]);
  
  // Modifier-of edges visible when at least one endpoint is selected, so
  // that selecting a bare topic (which has no prereq edges) reveals its
  // morphological connections to the modifiers that elaborate it.
  const modifierEdges = useMemo(() => {
    if (!selectedConcept) return [];
    return COURSE.modifier_pairs
      .filter(p => p.modifier === selectedConcept || p.target === selectedConcept)
      .map(p => ({
        from: p.modifier,
        to: p.target,
        kind: 'modifier',
      }));
  }, [selectedConcept]);
  
  // Make sure modifier-of edge endpoints are in the render set when a
  // concept is selected. Modifier-of is sparse (typically 1-7 modifiers
  // per head), so this is bounded.
  // 
  // We deliberately do NOT pull in prereq endpoints — for hub concepts
  // like `inverter` that has 25+ prereq connections, that would explode
  // the visible set. Prereq edges still HIGHLIGHT (orange) when a node is
  // selected, but only between concepts that are already in the focus
  // top-20 or are slide-relevant.
  const renderConcepts = useMemo(() => {
    const ids = new Set(focusConcepts.map(c => c.id));
    const extra = [];
    const include = (id) => {
      if (!ids.has(id)) {
        const c = conceptById(id);
        if (c) { extra.push(c); ids.add(id); }
      }
    };
    modifierEdges.forEach(e => { include(e.from); include(e.to); });
    return [...focusConcepts, ...extra];
  }, [focusConcepts, modifierEdges]);
  
  // Visible prereq edges: any edge where both endpoints are in the render
  // set. This expands automatically when selection pulls in extra nodes.
  const visibleEdges = useMemo(() => {
    const visible = new Set(renderConcepts.map(c => c.id));
    return COURSE.prereq_edges.filter(e => visible.has(e.from) && visible.has(e.to));
  }, [renderConcepts]);
  
  const slideConceptSet = useMemo(() =>
    selectedSlide ? new Set(slideById(selectedSlide)?.concept_ids || []) : new Set(),
    [selectedSlide]
  );
  
  // Split nodes so selected/hovered render last (on top of others)
  const [bgNodes, fgNodes] = useMemo(() => {
    const bg = [], fg = [];
    renderConcepts.forEach(c => {
      if (c.id === selectedConcept || c.id === hoveredConcept) fg.push(c);
      else bg.push(c);
    });
    return [bg, fg];
  }, [renderConcepts, selectedConcept, hoveredConcept]);
  
  // Concepts whose names should appear when something is selected.
  // Modifier-of relations are sparse and meaningful (typically 1-7), so we
  // always show those labels. Prereq edges are NOT labeled by default —
  // for hub concepts like `inverter` that have 20+ prereq connections,
  // labeling all of them creates a wall of overlapping text. The user
  // can hover individual nodes to see their labels on demand. The orange
  // edges already show the relationship structure visually.
  const morphologicallyRelated = useMemo(() => {
    if (!selectedConcept) return new Set();
    const visible = new Set(renderConcepts.map(c => c.id));
    const set = new Set();
    COURSE.modifier_pairs.forEach(p => {
      if (p.modifier === selectedConcept && visible.has(p.target)) set.add(p.target);
      if (p.target === selectedConcept && visible.has(p.modifier)) set.add(p.modifier);
    });
    return set;
  }, [selectedConcept, renderConcepts]);
  
  // Prereq-connected concepts to label (capped to avoid hub-concept explosion).
  // We cap at 6 endpoints, ranked by their global importance score, so when
  // a hub concept like `inverter` is selected we don't end up labeling 25+
  // nodes — but for lower-degree concepts we DO label all their connections,
  // so the network actually shows what they relate to.
  const prereqLabeledNeighbors = useMemo(() => {
    if (!selectedConcept) return new Set();
    const visible = new Set(renderConcepts.map(c => c.id));
    const neighbors = [];
    COURSE.prereq_edges.forEach(e => {
      if (e.from === selectedConcept && visible.has(e.to)) neighbors.push(e.to);
      if (e.to === selectedConcept && visible.has(e.from)) neighbors.push(e.from);
    });
    // Rank by global importance and take top 6
    const scored = neighbors.map(id => {
      const c = conceptById(id);
      return { id, score: c ? c.confidence * Math.log(c.total_freq + 1) : 0 };
    }).sort((a, b) => b.score - a.score).slice(0, 6);
    return new Set(scored.map(x => x.id));
  }, [selectedConcept, renderConcepts]);
  
  // Single node renderer used for both background and foreground passes.
  // Selection styling: inverted fill (navy ink), orange ring offset from
  // the body, sticky label below. The ring is rendered FIRST so it sits
  // behind the body — that prevents the visual ambiguity of "is this two
  // overlapping things or one selection?"
  const renderNode = (nodes) => nodes.map(c => {
    const p = positions[c.id];
    if (!p) return null;
    const isInSlide = slideConceptSet.has(c.id);
    const isHovered = hoveredConcept === c.id;
    const isSelected = selectedConcept === c.id;
    const isMorphRelated = morphologicallyRelated.has(c.id);
    const isPrereqLabeled = prereqLabeledNeighbors.has(c.id);
    const r = 4 + Math.min(8, c.total_freq);
    // Show labels for: the selected node, hovered, in-slide (orange dots),
    // morphologically-related (modifier-of), and the top prereq neighbors of
    // the selection (capped). For hub concepts the cap prevents flooding;
    // for less-connected concepts all their neighbors get labeled.
    const showLabel = isHovered || isInSlide || isSelected || isMorphRelated || isPrereqLabeled;
    
    // Estimate label width (very rough — JetBrains Mono is fairly fixed width).
    // Used to decide where to anchor the label so it doesn't clip the edge.
    const fontSize = isSelected ? 11 : 9.5;
    const charWidth = fontSize * 0.62;
    const labelWidth = c.label.length * charWidth;
    
    // Decide anchor: if the label centered on the node would clip the
    // left edge, anchor at start (label extends rightward from the node).
    // Symmetric for right edge. Otherwise center.
    const halfLabel = labelWidth / 2;
    let anchor = 'middle';
    let labelX = 0;
    if (p.x - halfLabel < 4) {
      anchor = 'start';
      labelX = -r;  // start just to the left of the node, extending right
    } else if (p.x + halfLabel > width - 4) {
      anchor = 'end';
      labelX = r;  // end just to the right of the node, extending left
    }
    
    return (
      <g key={c.id}
         transform={`translate(${p.x}, ${p.y})`}
         style={{ cursor: 'pointer', touchAction: 'manipulation' }}
         onPointerEnter={(e) => {
           // Only treat as hover for actual mouse — pen/touch should not
           // leave a sticky hover state behind, which on iOS Safari was
           // causing the readout to show '▸' (hovered) rather than '◉'
           // (selected) after a tap.
           if (e.pointerType === 'mouse') setHoveredConcept(c.id);
         }}
         onPointerLeave={(e) => {
           if (e.pointerType === 'mouse') setHoveredConcept(null);
         }}
         onPointerUp={(e) => {
           // Use pointer events instead of click for selection. Click on
           // SVG <g> elements is unreliable on iOS Safari — sometimes the
           // synthetic click never fires after a touch sequence, leaving
           // only the hover state active. pointerup fires reliably across
           // mouse, pen, and touch.
           e.preventDefault();
           // Clear any sticky hover from prior touch interactions
           if (e.pointerType !== 'mouse') setHoveredConcept(null);
           onConceptClick(isSelected ? null : c.id);
         }}>
        {/* Outer ring marker indicators */}
        {isSelected && (
          <circle r={r + 5}
            fill="none"
            stroke="#c1501c"
            strokeWidth={1.4}
            strokeDasharray={c.is_free_standing ? "none" : "2,2"} />
        )}
        {/* In-slide indicator: thin outer ring, NOT a filled body. This
            decouples slide-membership ("taught here") from selection-
            relationship ("connected to what you selected"), which were
            previously colliding because both used orange.
            We suppress this ring on the selected node itself (its halo
            already says everything). */}
        {isInSlide && !isSelected && (
          <circle r={r + 3}
            fill="none"
            stroke="#c1501c"
            strokeWidth={1}
            opacity={0.7} />
        )}
        <circle r={r}
          fill={isSelected ? '#1a2332' : '#f5efe2'}
          stroke={isSelected ? '#c1501c' : '#1a2332'}
          strokeWidth={isSelected ? 1.8 : isHovered ? 2 : 1}
          opacity={
            // Dim unrelated node bodies when something is selected, so the
            // user's eye is drawn to the active subgraph
            selectedConcept && !isSelected && !isInSlide && !isHovered && !isMorphRelated && !isPrereqLabeled
              ? 0.4
              : 1
          } />
        {showLabel && (
          <text x={labelX} y={r + (isSelected ? 14 : 11)} textAnchor={anchor}
                fontSize={fontSize}
                fontWeight={isSelected ? 600 : 400}
                fontFamily="JetBrains Mono, monospace"
                fill={isSelected ? '#c1501c' : '#1a2332'}
                opacity={(isMorphRelated || isPrereqLabeled) && !isSelected && !isInSlide && !isHovered ? 0.85 : 1}
                style={{ pointerEvents: 'none', paintOrder: 'stroke' }}
                stroke="#f5efe2"
                strokeWidth="3"
                strokeLinejoin="round">
            {c.label}
          </text>
        )}
      </g>
    );
  });
  
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <polygon points="0 0, 6 3, 0 6" fill="#1a2332" opacity="0.5" />
        </marker>
        <pattern id="netgrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#cdc4b0" strokeWidth="0.3" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#netgrid)" />
      
      {visibleEdges.map((e, i) => {
        const a = positions[e.from], b = positions[e.to];
        if (!a || !b) return null;
        const isSel = selectedConcept === e.from || selectedConcept === e.to;
        const isHi = hoveredConcept === e.from || hoveredConcept === e.to;
        const active = isSel || isHi;
        // When something is selected, dim unrelated edges further so the
        // user's eye locks onto the highlighted ones. With nothing selected
        // we keep all edges at the default visibility.
        const baseOpacity = selectedConcept ? 0.1 : 0.25;
        return (
          <line key={`pre-${i}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={active ? '#c1501c' : '#1a2332'}
            strokeWidth={isSel ? 1.8 : isHi ? 1.5 : 0.6}
            opacity={active ? 0.9 : baseOpacity}
            markerEnd="url(#arrowhead)" />
        );
      })}
      
      {/* Modifier-of edges: only shown when one endpoint is selected.
          Visually distinct (dotted, lighter color) to communicate that
          this is a morphological/structural relation, not pedagogical. */}
      {modifierEdges.map((e, i) => {
        const a = positions[e.from], b = positions[e.to];
        if (!a || !b) return null;
        return (
          <line key={`mod-${i}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="#c1501c"
            strokeWidth={0.9}
            opacity={0.7}
            strokeDasharray="3,2" />
        );
      })}
      
      {/* Background nodes (not selected, not hovered) */}
      {renderNode(bgNodes)}
      
      {/* Foreground nodes (selected/hovered) — rendered last so their
          halos and labels sit on top */}
      {renderNode(fgNodes)}
    </svg>
  );
}

// ════════════════════════════════════════════════════════════════
// CHAT PANEL
// ════════════════════════════════════════════════════════════════

function ChatPanel({ onSlideClick }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const scrollerRef = useRef(null);
  
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages, loading]);
  
  const send = async () => {
    if (!input.trim() || loading) return;
    const q = input.trim();
    setInput('');
    setError(null);
    const newMessages = [...messages, { role: 'user', content: q }];
    setMessages(newMessages);
    setLoading(true);
    try {
      const { text, citedSlides, seedConcepts, retrievalKind, contributingCourses } = await askClaude(q, messages);
      setMessages([...newMessages, {
        role: 'assistant', content: text, citedSlides, seedConcepts, retrievalKind, contributingCourses
      }]);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };
  
  const exemplarQs = [
    "What's the difference between active and reactive power control?",
    "How does fault ride-through work?",
    "How do inverter basics from Lesson 2 connect to inverter operating principles in Lesson 3?",
  ];
  
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: '#f5efe2', borderLeft: '1px solid #1a2332',
    }}>
      <div style={{
        padding: '14px 18px 12px', borderBottom: '1px solid #1a2332',
        background: '#1a2332', color: '#f5efe2',
      }}>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
          letterSpacing: '0.18em', opacity: 0.7, marginBottom: 4,
        }}>
          ─── INTERLOCUTOR ─── {FEDERATION.length > 0 ? `via federated graph (${ALL_COURSES.length} courses)` : 'via graph'}
        </div>
        <div style={{ fontFamily: 'EB Garamond, Georgia, serif', fontSize: 22, fontStyle: 'italic' }}>
          Chat with the course
        </div>
      </div>
      
      <div ref={scrollerRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        {messages.length === 0 && (
          <div style={{ color: '#1a2332', opacity: 0.85 }}>
            <div style={{
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
              fontSize: 15, marginBottom: 18, lineHeight: 1.55,
            }}>
              Questions are answered by traversing the federated course graph
              {FEDERATION.length > 0 ? ` across ${ALL_COURSES.length} loaded courses (primary: ${COURSE.package.course_label}; peers: ${FEDERATION.map(f => f.package.course_label).join(', ')})` : ''}:
              relevant concepts are matched, expanded one hop through prerequisite
              and modifier-of edges, and the slides where those concepts are taught
              are passed to the model as context. Cited peer-course slides are marked
              with <span style={{ color: '#c1501c' }}>⊕</span> and the source course label.
            </div>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
              letterSpacing: '0.15em', opacity: 0.6, marginBottom: 8,
            }}>
              ── TRY ──
            </div>
            {exemplarQs.map((q, i) => (
              <button key={i} onClick={() => setInput(q)} style={{
                display: 'block', textAlign: 'left', width: '100%',
                padding: '8px 10px', marginBottom: 6,
                background: 'transparent', border: '1px solid #1a2332',
                borderRadius: 0, fontFamily: 'EB Garamond, serif',
                fontSize: 14, fontStyle: 'italic', color: '#1a2332',
                cursor: 'pointer', transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(26, 35, 50, 0.08)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                {q}
              </button>
            ))}
          </div>
        )}
        
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 18 }}>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
              letterSpacing: '0.18em',
              color: m.role === 'user' ? '#c1501c' : '#1a2332',
              opacity: 0.7, marginBottom: 4,
            }}>
              {m.role === 'user' ? '── YOU ──' : '── COURSE ──'}
            </div>
            <div style={{
              fontFamily: m.role === 'user' ? 'JetBrains Mono, monospace' : 'EB Garamond, Georgia, serif',
              fontSize: m.role === 'user' ? 13 : 16,
              lineHeight: m.role === 'user' ? 1.5 : 1.55,
              color: '#1a2332', whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
            {/* Retrieval breadcrumbs */}
            {m.role === 'assistant' && m.seedConcepts && (
              <div style={{
                marginTop: 6, fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9, opacity: 0.55, lineHeight: 1.5,
              }}>
                ▸ retrieval: {m.retrievalKind} · seeds: {
                  m.seedConcepts.length > 0
                    ? m.seedConcepts.slice(0, 4).map(({ c, course }) =>
                        course.package.course_id === COURSE.package.course_id
                          ? c.label
                          : `${c.label} [${course.package.course_label}]`
                      ).join(', ')
                    : 'no local match — federation searched'
                }
                {m.contributingCourses && m.contributingCourses.length > 1 && (
                  <span style={{ marginLeft: 6 }}>· federated</span>
                )}
              </div>
            )}
            {m.citedSlides && m.citedSlides.length > 0 && (
              <div style={{
                marginTop: 8, paddingTop: 8,
                borderTop: '0.5px dashed #1a2332',
              }}>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 8.5,
                  letterSpacing: '0.18em', opacity: 0.6, marginBottom: 6,
                }}>
                  CITED
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {m.citedSlides.map(({ slide, course }, i) => {
                    const isPeer = course.package.course_id !== COURSE.package.course_id;
                    return (
                      <button key={`${course.package.course_id}-${slide.id}-${i}`}
                        onClick={() => isPeer ? null : onSlideClick(slide.id)}
                        title={isPeer ? `From peer course: ${course.package.course_label} — not navigable in this view` : ''}
                        style={{
                          padding: '3px 8px',
                          background: isPeer ? 'rgba(193, 80, 28, 0.06)' : 'transparent',
                          border: `1px solid ${isPeer ? '#c1501c' : '#1a2332'}`,
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 10, color: '#1a2332',
                          cursor: isPeer ? 'help' : 'pointer',
                        }}>
                        {isPeer && <span style={{ color: '#c1501c', marginRight: 4 }}>⊕</span>}
                        §{slide.sequence_index + 1} {slide.title}
                        {isPeer && <span style={{ opacity: 0.6, marginLeft: 6, fontSize: 9 }}>{course.package.course_label}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
        
        {loading && (
          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
              letterSpacing: '0.18em', opacity: 0.5, marginBottom: 4,
            }}>
              ── COURSE ──
            </div>
            <div style={{
              fontFamily: 'EB Garamond, serif', fontSize: 15,
              fontStyle: 'italic', color: '#1a2332', opacity: 0.7,
            }}>
              Traversing the graph
              <span className="dot-blink">.</span>
              <span className="dot-blink" style={{ animationDelay: '0.2s' }}>.</span>
              <span className="dot-blink" style={{ animationDelay: '0.4s' }}>.</span>
            </div>
          </div>
        )}
        
        {error && (
          <div style={{
            padding: 10, border: '1px solid #c1501c', color: '#c1501c',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 11, marginBottom: 12,
          }}>
            {error}
          </div>
        )}
      </div>
      
      <div style={{
        borderTop: '1px solid #1a2332', padding: 10,
        display: 'flex', gap: 8,
      }}>
        <input type="text" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder="Ask about the course…" disabled={loading}
          style={{
            flex: 1, padding: '8px 10px', background: '#fdf9ee',
            border: '1px solid #1a2332',
            fontFamily: 'EB Garamond, Georgia, serif',
            fontSize: 14, fontStyle: 'italic', color: '#1a2332', outline: 'none',
          }} />
        <button onClick={send} disabled={loading || !input.trim()} style={{
          padding: '8px 14px', background: '#1a2332', color: '#f5efe2',
          border: '1px solid #1a2332', fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11, letterSpacing: '0.1em',
          cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
          opacity: loading || !input.trim() ? 0.5 : 1,
        }}>
          ASK ↵
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// LEGEND — explains the visual language of the network
// ════════════════════════════════════════════════════════════════

function Legend({ onClose }) {
  // Each row: a small inline SVG showing the visual, and a brief explanation.
  // We render the visuals at 1:1 with how they appear in the actual graph,
  // not stylized — so the user sees exactly what to look for.
  const Row = ({ children, label }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '6px 0',
    }}>
      <div style={{ width: 56, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {children}
      </div>
      <div style={{
        fontFamily: 'EB Garamond, serif',
        fontSize: 14, lineHeight: 1.35,
        color: '#1a2332',
      }}>
        {label}
      </div>
    </div>
  );

  return (
    <div style={{
      border: '1px solid #1a2332',
      background: '#f5efe2',
      padding: '14px 18px',
      marginBottom: 16,
      position: 'relative',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 10,
      }}>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
          letterSpacing: '0.2em', opacity: 0.6,
        }}>
          ── HOW TO READ ──
        </div>
        <button onClick={onClose} aria-label="close legend"
          style={{
            background: 'transparent', border: 'none',
            color: '#1a2332', fontFamily: 'JetBrains Mono, monospace',
            fontSize: 14, cursor: 'pointer', padding: '2px 6px',
            lineHeight: 1,
          }}>✕</button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '4px 24px',
      }}>
        {/* Node states */}
        <div>
          <div style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
            letterSpacing: '0.18em', opacity: 0.55,
            marginBottom: 4, marginTop: 4,
          }}>
            NODES
          </div>
          <Row label={<>Selected concept (free-standing)</>}>
            <svg width={42} height={28} viewBox="0 0 42 28">
              <circle cx={21} cy={14} r={11} fill="none" stroke="#c1501c" strokeWidth={1.4}/>
              <circle cx={21} cy={14} r={7} fill="#1a2332" stroke="#c1501c" strokeWidth={1.8}/>
            </svg>
          </Row>
          <Row label={<>Selected concept (bare topic — head word like <em>voltage</em>)</>}>
            <svg width={42} height={28} viewBox="0 0 42 28">
              <circle cx={21} cy={14} r={11} fill="none" stroke="#c1501c" strokeWidth={1.4} strokeDasharray="2,2"/>
              <circle cx={21} cy={14} r={7} fill="#1a2332" stroke="#c1501c" strokeWidth={1.8}/>
            </svg>
          </Row>
          <Row label={<>Concept taught in current slide</>}>
            <svg width={42} height={28} viewBox="0 0 42 28">
              <circle cx={21} cy={14} r={9} fill="none" stroke="#c1501c" strokeWidth={1} opacity={0.7}/>
              <circle cx={21} cy={14} r={6} fill="#f5efe2" stroke="#1a2332" strokeWidth={1}/>
            </svg>
          </Row>
          <Row label={<>Other free-standing concept (top 20 by importance)</>}>
            <svg width={42} height={28} viewBox="0 0 42 28">
              <circle cx={21} cy={14} r={6} fill="#f5efe2" stroke="#1a2332" strokeWidth={1}/>
            </svg>
          </Row>
        </div>

        {/* Edge states */}
        <div>
          <div style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
            letterSpacing: '0.18em', opacity: 0.55,
            marginBottom: 4, marginTop: 4,
          }}>
            EDGES
          </div>
          <Row label={<>Inferred prerequisite (highlighted when selection touches it)</>}>
            <svg width={42} height={28} viewBox="0 0 42 28">
              <line x1={4} y1={14} x2={38} y2={14} stroke="#c1501c" strokeWidth={1.8} opacity={0.9}/>
              <polygon points="36,11 38,14 36,17" fill="#c1501c"/>
            </svg>
          </Row>
          <Row label={<>Inferred prerequisite (background — both endpoints unrelated to selection)</>}>
            <svg width={42} height={28} viewBox="0 0 42 28">
              <line x1={4} y1={14} x2={38} y2={14} stroke="#1a2332" strokeWidth={0.6} opacity={0.4}/>
              <polygon points="36,11 38,14 36,17" fill="#1a2332" opacity={0.4}/>
            </svg>
          </Row>
          <Row label={<>Modifier-of (head-modifier relation, e.g. <em>terminal voltage</em> modifies <em>voltage</em>)</>}>
            <svg width={42} height={28} viewBox="0 0 42 28">
              <line x1={4} y1={14} x2={38} y2={14} stroke="#c1501c" strokeWidth={0.9} opacity={0.7} strokeDasharray="3,2"/>
            </svg>
          </Row>
        </div>
      </div>

      <div style={{
        marginTop: 12, paddingTop: 10,
        borderTop: '0.5px dashed #1a2332',
        fontFamily: 'EB Garamond, serif',
        fontSize: 13, fontStyle: 'italic', lineHeight: 1.5,
        color: '#1a2332', opacity: 0.85,
      }}>
        Tap any node to select it. Selecting a concept reveals its prerequisite
        and modifier-of relationships, and dims unrelated structure. The
        currently selected slide's concepts are marked with a thin orange ring,
        independent of selection — a node can both be in-slide and connected
        to your selection.
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ════════════════════════════════════════════════════════════════

export default function Dashboard() {
  const [selectedSlide, setSelectedSlide] = useState(COURSE.slides[1]?.id || COURSE.slides[0]?.id);
  const [selectedConcept, setSelectedConcept] = useState(null);
  const [hoveredConcept, setHoveredConcept] = useState(null);
  // Mobile drawer state — both default closed; opening one closes the other
  const [navOpen, setNavOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  
  // Inject the mobile viewport meta tag — without this, mobile browsers
  // render at the desktop default width and CSS media queries don't fire.
  useEffect(() => {
    let m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement('meta');
      m.setAttribute('name', 'viewport');
      document.head.appendChild(m);
    }
    m.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1');
  }, []);
  
  const slide = slideById(selectedSlide);
  const slideConcepts = slide ? conceptsForSlide(slide.id) : [];
  const slidePrereqs = slide ? prereqsOfSlide(slide.id) : [];
  const concept = selectedConcept ? conceptById(selectedConcept) : null;
  
  // For the selected concept: show modifier group and target
  const conceptModifiers = concept ? modifiersOf(concept.id) : [];
  const conceptTarget = concept ? targetOf(concept.id) : null;
  
  const fsCount = COURSE.concepts.filter(c => c.is_free_standing).length;
  
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; background: #ddd4be; color: #1a2332; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #ddd4be; }
        ::-webkit-scrollbar-thumb { background: #1a2332; border-radius: 0; }
        .dashboard-root {
          min-height: 100vh;
          background:
            repeating-linear-gradient(0deg, transparent 0, transparent 39px,
              rgba(26, 35, 50, 0.04) 39px, rgba(26, 35, 50, 0.04) 40px),
            #f5efe2;
          color: #1a2332;
          font-family: 'EB Garamond', Georgia, serif;
        }
        .dot-blink { animation: dot-blink 1.4s infinite; opacity: 0; }
        @keyframes dot-blink {
          0%, 80%, 100% { opacity: 0; }
          40% { opacity: 1; }
        }
        .slide-button {
          width: 100%; text-align: left; padding: 6px 10px;
          background: transparent; border: none;
          border-left: 2px solid transparent;
          font-family: 'EB Garamond', Georgia, serif;
          font-size: 14px; color: #1a2332; cursor: pointer;
          transition: all 0.15s; line-height: 1.3; display: flex; gap: 8px;
        }
        .slide-button:hover { background: rgba(26, 35, 50, 0.06); }
        .slide-button.active {
          border-left-color: #c1501c; background: rgba(193, 80, 28, 0.08);
        }
        .slide-button .num {
          font-family: 'JetBrains Mono', monospace; font-size: 10px;
          opacity: 0.5; padding-top: 2px; min-width: 24px;
        }
        
        /* ============ LAYOUT: desktop default, mobile override ============ */
        .dashboard-grid {
          max-width: 1480px; margin: 0 auto;
          display: grid; grid-template-columns: 260px 1fr 460px;
          min-height: 100vh;
          border-left: 1px solid #1a2332;
          border-right: 1px solid #1a2332;
        }
        .nav-rail {
          border-right: 1px solid #1a2332; background: #f5efe2;
          padding: 20px 14px 32px;
          position: sticky; top: 0; align-self: flex-start;
          height: 100vh; overflow-y: auto;
        }
        .center-main { padding: 28px 36px 60px; min-width: 0; }
        .chat-rail { position: sticky; top: 0; height: 100vh; }
        
        /* Mobile-only elements hidden by default */
        .mobile-bar { display: none; }
        .drawer-backdrop { display: none; }
        .mobile-only { display: none; }
        .nav-close, .chat-close { display: none; }
        
        @media (max-width: 768px) {
          .dashboard-grid {
            grid-template-columns: 1fr;
            border-left: none; border-right: none;
          }
          /* Slide-out drawer for nav rail */
          .nav-rail {
            position: fixed;
            top: 0; left: 0;
            width: 280px; max-width: 85vw;
            height: 100vh; z-index: 1000;
            transform: translateX(-100%);
            transition: transform 0.25s ease;
            box-shadow: 4px 0 20px rgba(26, 35, 50, 0.2);
            border-right: 1px solid #1a2332;
            padding-top: 56px;
          }
          .nav-rail.open { transform: translateX(0); }
          /* Slide-up drawer for chat */
          .chat-rail {
            position: fixed;
            bottom: 0; left: 0; right: 0;
            top: auto;
            height: 80vh;
            width: 100%;
            z-index: 1000;
            transform: translateY(100%);
            transition: transform 0.25s ease;
            box-shadow: 0 -4px 20px rgba(26, 35, 50, 0.2);
          }
          .chat-rail.open { transform: translateY(0); }
          
          /* Backdrop overlay when drawer open */
          .drawer-backdrop {
            display: block;
            position: fixed; inset: 0;
            background: rgba(26, 35, 50, 0.4);
            z-index: 999;
            opacity: 0; pointer-events: none;
            transition: opacity 0.2s;
          }
          .drawer-backdrop.show { opacity: 1; pointer-events: auto; }
          
          /* Persistent top bar with hamburger + chat trigger */
          .mobile-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: sticky; top: 0;
            background: #1a2332; color: #f5efe2;
            padding: 10px 14px;
            z-index: 100;
            border-bottom: 1px solid #1a2332;
          }
          .mobile-bar button {
            background: transparent; border: 1px solid #f5efe2;
            color: #f5efe2; padding: 6px 10px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px; letter-spacing: 0.08em;
            cursor: pointer; min-height: 36px;
          }
          .mobile-bar .title {
            font-family: 'EB Garamond', serif;
            font-style: italic; font-size: 16px;
            flex: 1; text-align: center;
            margin: 0 8px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          }
          .mobile-only { display: block; }
          
          .nav-close, .chat-close {
            display: block;
            position: absolute; top: 10px; right: 12px;
            background: transparent; border: 1px solid #1a2332;
            color: #1a2332; font-family: 'JetBrains Mono', monospace;
            font-size: 12px; padding: 4px 9px;
            cursor: pointer;
            z-index: 1;
          }
          .chat-close { color: #f5efe2; border-color: #f5efe2; top: 14px; right: 14px; }
          
          .center-main { padding: 16px 14px 80px; }
          
          /* Buttons get bigger tap targets on touch */
          .slide-button { padding: 10px 12px; min-height: 44px; }
          
          /* Stats grid on mobile: keep 2 cols but tighter */
          .stats-grid { font-size: 9.5px !important; }
          
          /* Hide the slide indicator in the figure header on mobile —
             the slide title is already in the top mobile bar, redundant */
          .hide-on-narrow { display: none; }
        }
      `}</style>
      
      <div className="dashboard-root">
        {/* Mobile-only top bar with drawer triggers */}
        <div className="mobile-bar mobile-only">
          <button onClick={() => { setNavOpen(true); setChatOpen(false); }}
                  aria-label="open navigation">
            ≡ MENU
          </button>
          <span className="title">{slide?.title || 'Lesson 3'}</span>
          <button onClick={() => { setChatOpen(true); setNavOpen(false); }}
                  aria-label="open chat">
            ASK
          </button>
        </div>
        
        {/* Backdrop overlay (mobile only, only visible when a drawer is open) */}
        <div className={`drawer-backdrop ${(navOpen || chatOpen) ? 'show' : ''}`}
             onClick={() => { setNavOpen(false); setChatOpen(false); }} />
        
        <div className="dashboard-grid">
          
          {/* LEFT: NAVIGATOR */}
          <aside className={`nav-rail ${navOpen ? 'open' : ''}`}>
            <button className="nav-close mobile-only" onClick={() => setNavOpen(false)}>✕</button>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
              letterSpacing: '0.2em', opacity: 0.6, marginBottom: 6,
            }}>
              FOXXI ⟢ CONTEXT&nbsp;GRAPH
            </div>
            <div style={{
              fontFamily: 'EB Garamond, Georgia, serif',
              fontStyle: 'italic', fontSize: 24, lineHeight: 1.05,
              marginBottom: 4, color: '#1a2332',
            }}>
              Lesson 3
            </div>
            <div style={{
              fontFamily: 'EB Garamond, Georgia, serif', fontSize: 15,
              marginBottom: 22, opacity: 0.85,
            }}>
              Inverter Controls
            </div>
            
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 8.5,
              letterSpacing: '0.18em', opacity: 0.55, padding: '4px 0',
              borderTop: '0.5px solid #1a2332', borderBottom: '0.5px solid #1a2332',
              marginBottom: 16, display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)', gap: 4,
            }}>
              <div>SCENES <span style={{ color: '#c1501c' }}>{COURSE.scenes.length}</span></div>
              <div>SLIDES <span style={{ color: '#c1501c' }}>{COURSE.slides.length}</span></div>
              <div>CONCEPTS <span style={{ color: '#c1501c' }}>{fsCount}/{COURSE.concepts.length}</span></div>
              <div>EDGES <span style={{ color: '#c1501c' }}>{COURSE.prereq_edges.length}</span></div>
              <div>MOD-OF <span style={{ color: '#c1501c' }}>{COURSE.modifier_pairs.length}</span></div>
              <div>FREE/ALL</div>
            </div>
            
            {COURSE.scenes.map(scene => (
              <div key={scene.id} style={{ marginBottom: 18 }}>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                  letterSpacing: '0.18em', opacity: 0.6, marginBottom: 6,
                }}>
                  ── SCENE {scene.scene_number} ──
                </div>
                {scene.slide_ids.map(sid => {
                  const s = slideById(sid);
                  if (!s) return null;
                  return (
                    <button key={sid}
                      className={`slide-button ${selectedSlide === sid ? 'active' : ''}`}
                      onClick={() => { setSelectedSlide(sid); setSelectedConcept(null); setNavOpen(false); }}>
                      <span className="num">§{s.sequence_index + 1}</span>
                      <span>{s.title}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            
            <div style={{
              marginTop: 24, paddingTop: 12, borderTop: '0.5px solid #1a2332',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
              opacity: 0.55, lineHeight: 1.6,
            }}>
              <div>parser/v{COURSE.package.parser_version}</div>
              <div>vocab/v{COURSE.package.vocab_version}</div>
              <div>{COURSE.package.standard}</div>
              <div>{COURSE.package.authoring_tool}</div>
              <div style={{ marginTop: 6, color: '#c1501c' }}>
                ✓ vocab self-conforms
              </div>
              <div>
                ✓ {COURSE.package.course_label} conforms ({COURSE.stats.concepts_total + COURSE.stats.prereq_edges + COURSE.stats.modifier_pairs * 2 + COURSE.stats.slides * 4}+ triples, 0 violations)
              </div>
              {FEDERATION.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 6, borderTop: '0.5px dashed #1a2332' }}>
                  <div style={{ letterSpacing: '0.18em', marginBottom: 2 }}>FEDERATION</div>
                  {FEDERATION.map(f => (
                    <div key={f.package.course_id}>
                      ⊕ {f.package.course_label} <span style={{ opacity: 0.7 }}>({f.slides.length} slides, {f.concepts.length} concepts)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
          
          {/* CENTER */}
          <main className="center-main">
            <div style={{
              border: '1px solid #1a2332', background: '#fdf9ee',
              padding: '14px 18px', marginBottom: 24,
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'baseline', marginBottom: 8, gap: 12,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                    letterSpacing: '0.2em', opacity: 0.6,
                  }}>
                    FIG. 01 — CONCEPT&nbsp;TOPOLOGY
                  </div>
                  <div style={{
                    fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
                    fontSize: 17, marginTop: 2,
                  }}>
                    Top concepts and their inferred dependencies
                  </div>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  flexShrink: 0,
                }}>
                  {selectedSlide && slide && (
                    <span style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 10, opacity: 0.7,
                      whiteSpace: 'nowrap',
                    }}>
                      <span style={{ color: '#c1501c' }}>○</span>{' '}
                      <span className="hide-on-narrow">{slide.title.length > 22 ? slide.title.slice(0, 22) + '…' : slide.title}</span>
                    </span>
                  )}
                  <button
                    onClick={() => setLegendOpen(o => !o)}
                    aria-label={legendOpen ? "hide legend" : "show legend"}
                    style={{
                      width: 24, height: 24,
                      borderRadius: '50%',
                      border: '1px solid #1a2332',
                      background: legendOpen ? '#1a2332' : 'transparent',
                      color: legendOpen ? '#f5efe2' : '#1a2332',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 12, fontWeight: 600,
                      cursor: 'pointer', padding: 0, lineHeight: 1,
                      flexShrink: 0,
                    }}>
                    ?
                  </button>
                </div>
              </div>
              
              {legendOpen && (
                <Legend onClose={() => setLegendOpen(false)} />
              )}
              
              <ConceptNetwork
                selectedSlide={selectedSlide}
                selectedConcept={selectedConcept}
                onConceptClick={(conceptId) => {
                  // Toggle off if clicking the same concept again
                  if (conceptId === null || conceptId === selectedConcept) {
                    setSelectedConcept(null);
                    return;
                  }
                  setSelectedConcept(conceptId);
                  // If the clicked concept ISN'T taught in the current slide,
                  // jump to a slide where it IS taught. This is what makes
                  // "click node → tag highlights below" actually work for
                  // concepts that aren't in the current slide's tag list —
                  // otherwise there's nothing for the tag system to highlight.
                  const concept = conceptById(conceptId);
                  if (concept && selectedSlide && !concept.taught_in_slides.includes(selectedSlide)) {
                    const firstSlide = firstSlideForConcept(conceptId);
                    if (firstSlide) setSelectedSlide(firstSlide);
                  }
                }}
                hoveredConcept={hoveredConcept}
                setHoveredConcept={setHoveredConcept} />
              {(hoveredConcept || selectedConcept) && (() => {
                const id = hoveredConcept || selectedConcept;
                const c = conceptById(id);
                if (!c) return null;
                // Three states:
                //   ◉  — selected, no hover (or hovered=selected)
                //   ⊙  — currently hovering the selected concept
                //   ▸  — hovering a non-selected concept (selection elsewhere)
                let marker = '▸';
                if (selectedConcept === id) marker = hoveredConcept === id ? '⊙' : '◉';
                const isSel = selectedConcept === id;
                return (
                  <div style={{
                    marginTop: 6, fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10, color: '#1a2332', lineHeight: 1.4,
                  }}>
                    {marker}{' '}
                    <span style={{ color: '#c1501c' }}>{c.label}</span>
                    <span style={{ opacity: 0.55 }}>
                      {' '}· {c.taught_in_slides.length} slide{c.taught_in_slides.length === 1 ? '' : 's'}
                      {!c.is_free_standing && ' · bare topic'}
                      {isSel && <span style={{ marginLeft: 8 }}>[selected — tap again to dismiss]</span>}
                    </span>
                  </div>
                );
              })()}
            </div>
            
            {slide && (
              <article>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'baseline', borderBottom: '1px solid #1a2332',
                  paddingBottom: 8, marginBottom: 18,
                }}>
                  <div>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                      letterSpacing: '0.2em', opacity: 0.6,
                    }}>
                      § {slide.sequence_index + 1}
                      <span style={{ margin: '0 8px' }}>·</span>
                      SLIDE&nbsp;{slide.lms_id || slide.id.slice(0, 8)}
                    </div>
                    <h1 style={{
                      fontFamily: 'EB Garamond, Georgia, serif',
                      fontSize: 38, fontWeight: 500, margin: '4px 0 0',
                      lineHeight: 1.05, letterSpacing: '-0.01em',
                    }}>
                      {slide.title}
                    </h1>
                  </div>
                  <div style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                    textAlign: 'right', opacity: 0.7, lineHeight: 1.6,
                  }}>
                    {slide.audio_count > 0 && <div>♪ {slide.audio_count} narration{slide.audio_count > 1 ? 's' : ''}</div>}
                    {slide.transcript_segments.length > 0 && (
                      <div>{slide.transcript_segments.reduce((a, t) => a + t.duration, 0).toFixed(0)}s audio</div>
                    )}
                    <div>{slideConcepts.length} concept(s)</div>
                  </div>
                </div>
                
                <section style={{ marginBottom: 32 }}>
                  <div style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                    letterSpacing: '0.2em', opacity: 0.55, marginBottom: 6,
                  }}>
                    ── NARRATION TRANSCRIPT ──
                  </div>
                  {slide.transcript_combined ? (
                    <div style={{
                      fontFamily: 'EB Garamond, Georgia, serif',
                      fontSize: 18, lineHeight: 1.65,
                      maxWidth: '64ch', color: '#1a2332',
                    }}>
                      <span style={{
                        fontFamily: 'EB Garamond, serif', fontSize: 50,
                        float: 'left', lineHeight: 0.9,
                        margin: '6px 8px -2px 0', color: '#c1501c',
                        fontWeight: 500,
                      }}>
                        {slide.transcript_combined.charAt(0)}
                      </span>
                      <HighlightedTranscript
                        text={slide.transcript_combined.slice(1)}
                        conceptIds={slide.concept_ids}
                        onConceptClick={setSelectedConcept} />
                    </div>
                  ) : (
                    <div style={{
                      fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
                      fontSize: 15, opacity: 0.55,
                    }}>
                      No narration captured for this slide.
                      {slide.alt_text_corpus && (
                        <> On-screen labels recovered: <span style={{
                          fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
                        }}>{slide.alt_text_corpus.slice(0, 200)}</span></>
                      )}
                    </div>
                  )}
                </section>
                
                {slideConcepts.length > 0 && (
                  <section style={{ marginBottom: 32 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                      letterSpacing: '0.2em', opacity: 0.55, marginBottom: 8,
                    }}>
                      ── CONCEPTS TAUGHT ({slideConcepts.length}, {
                        slideConcepts.filter(c => c.is_free_standing).length
                      } free-standing) ──
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {slideConcepts
                        .sort((a, b) => (a.is_free_standing === b.is_free_standing ? b.confidence - a.confidence : (a.is_free_standing ? -1 : 1)))
                        .map(c => (
                        <button key={c.id} onClick={() => setSelectedConcept(selectedConcept === c.id ? null : c.id)} style={{
                          padding: '6px 10px 6px 12px',
                          background: selectedConcept === c.id ? '#c1501c' : (c.is_free_standing ? 'transparent' : 'rgba(26,35,50,0.04)'),
                          color: selectedConcept === c.id ? '#fdf9ee' : '#1a2332',
                          border: c.is_free_standing ? '1px solid #1a2332' : '1px dashed #1a2332',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 11, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 6,
                          fontStyle: c.is_free_standing ? 'normal' : 'italic',
                          opacity: c.is_free_standing ? 1 : 0.7,
                        }}>
                          {c.label}
                          <span style={{ fontSize: 9, opacity: 0.6 }}>
                            {c.confidence.toFixed(2)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                
                {slidePrereqs.length > 0 && (
                  <section style={{ marginBottom: 32 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                      letterSpacing: '0.2em', opacity: 0.55, marginBottom: 8,
                    }}>
                      ── PREREQUISITES (inferred) ──
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {slidePrereqs.slice(0, 12).map((e, i) => {
                        const c = conceptById(e.from);
                        if (!c) return null;
                        const firstSlide = firstSlideForConcept(c.id);
                        return (
                          <button key={i}
                            onClick={() => firstSlide && setSelectedSlide(firstSlide)}
                            style={{
                              padding: '4px 8px', background: '#fdf9ee',
                              border: '0.5px solid #1a2332',
                              fontFamily: 'EB Garamond, serif',
                              fontStyle: 'italic', fontSize: 13,
                              color: '#1a2332', cursor: 'pointer',
                            }}>
                            ↰ {c.label}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
                
                {slide.transcript_segments.length > 0 && (
                  <section style={{ marginBottom: 24 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                      letterSpacing: '0.2em', opacity: 0.55, marginBottom: 8,
                    }}>
                      ── AUDIO ASSETS ──
                    </div>
                    {slide.transcript_segments.map((t, i) => (
                      <div key={i} style={{
                        marginBottom: 8, padding: '8px 10px',
                        background: '#fdf9ee', border: '0.5px solid #1a2332',
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                        display: 'flex', justifyContent: 'space-between', gap: 12,
                      }}>
                        <span style={{
                          opacity: 0.6, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {t.audio_url}
                        </span>
                        <span style={{ color: '#c1501c', whiteSpace: 'nowrap' }}>
                          {t.duration.toFixed(1)}s · {t.segments?.length || 1} seg
                        </span>
                      </div>
                    ))}
                  </section>
                )}
              </article>
            )}
            
            {/* Concept detail with modifier group + target */}
            {concept && (
              <div style={{
                marginTop: 32, padding: '16px 20px',
                background: '#1a2332', color: '#f5efe2', position: 'relative',
              }}>
                <button onClick={() => setSelectedConcept(null)} style={{
                  position: 'absolute', top: 10, right: 12,
                  background: 'transparent', border: '1px solid #f5efe2',
                  color: '#f5efe2', fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10, padding: '2px 8px', cursor: 'pointer',
                }}>✕</button>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                  letterSpacing: '0.2em', opacity: 0.6, marginBottom: 4,
                }}>
                  ── CONCEPT ──
                  {!concept.is_free_standing && (
                    <span style={{ color: '#e89071', marginLeft: 12 }}>BARE TOPIC</span>
                  )}
                </div>
                <div style={{
                  fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
                  fontSize: 26, marginBottom: 10,
                }}>
                  {concept.label}
                </div>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                  opacity: 0.8, marginBottom: 14, lineHeight: 1.7,
                }}>
                  confidence&nbsp;<span style={{ color: '#e89071' }}>{concept.confidence.toFixed(2)}</span>
                  &nbsp;·&nbsp;tier&nbsp;<span style={{ color: '#e89071' }}>{concept.tier}</span>
                  &nbsp;·&nbsp;head&nbsp;<span style={{ color: '#e89071' }}>{concept.head_word}</span>
                  &nbsp;·&nbsp;in&nbsp;<span style={{ color: '#e89071' }}>{concept.taught_in_slides.length}</span>&nbsp;slide(s)
                </div>
                
                {/* Modifier of: this concept modifies a more general one */}
                {conceptTarget && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                      letterSpacing: '0.2em', opacity: 0.6, marginBottom: 6,
                    }}>
                      MODIFIES
                    </div>
                    <button onClick={() => setSelectedConcept(conceptTarget.id)} style={{
                      padding: '4px 9px', background: 'transparent',
                      border: '1px solid #e89071', color: '#e89071',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                      cursor: 'pointer',
                    }}>
                      ↗ {conceptTarget.label}
                    </button>
                  </div>
                )}
                
                {/* Modifier group: this concept has modifiers */}
                {conceptModifiers.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                      letterSpacing: '0.2em', opacity: 0.6, marginBottom: 6,
                    }}>
                      MODIFIED BY ({conceptModifiers.length})
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {conceptModifiers.map(m => (
                        <button key={m.id}
                          onClick={() => setSelectedConcept(m.id)}
                          style={{
                            padding: '4px 9px', background: 'transparent',
                            border: '1px solid #f5efe2', color: '#f5efe2',
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 10, cursor: 'pointer',
                          }}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                  letterSpacing: '0.2em', opacity: 0.6, marginBottom: 6,
                }}>
                  TAUGHT IN
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {concept.taught_in_slides.map(sid => {
                    const s = slideById(sid);
                    if (!s) return null;
                    return (
                      <button key={sid}
                        onClick={() => { setSelectedSlide(sid); setSelectedConcept(null); }}
                        style={{
                          padding: '4px 9px', background: 'transparent',
                          border: '1px solid #f5efe2', color: '#f5efe2',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 10, cursor: 'pointer',
                        }}>
                        §{s.sequence_index + 1} · {s.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </main>
          
          {/* RIGHT: CHAT */}
          <aside className={`chat-rail ${chatOpen ? 'open' : ''}`}>
            <button className="chat-close mobile-only" onClick={() => setChatOpen(false)}>✕</button>
            <ChatPanel onSlideClick={(sid) => { setSelectedSlide(sid); setChatOpen(false); }} />
          </aside>
        </div>
      </div>
    </>
  );
}
