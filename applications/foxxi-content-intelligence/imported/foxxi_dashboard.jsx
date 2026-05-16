import React, { useState, useEffect, useMemo, useRef } from 'react';

// ════════════════════════════════════════════════════════════════
// COURSE GRAPH DATA (parsed from Lesson_3_Inverter_Controls.zip
// by foxxi-storyline-parser v0.2.0)
// ════════════════════════════════════════════════════════════════
const RAW_DATA = `{"package":{"id":"_69JeglEuzyv","title":"Lesson 3: Inverter Controls","standard":"SCORM_2004_4","authoring_tool":"Articulate Storyline","authoring_version":"3.104.35448.0","parser_version":"0.2.0"},"stats":{"manifest_items":1,"manifest_resources":1,"scenes":2,"slides":12,"audio_files":22,"transcripts":22,"audio_seconds":604.7871250000001,"concepts":92,"prereq_edges":299},"scenes":[{"id":"6RdIHQ8sw43","title":"Scene 1","scene_number":1,"slide_ids":["5mxvVHmgKIk","6ps7ro4Er5o","5zBRyvxOwou","6eVptVTR2Lx","5q1PTTjK3aS","6KhIqryeG83","6cuGuY88hng","6JZsAHMHpvb","66RtiTQPuzj","5XHGBaZwOfD"]},{"id":"5sFB072XEDS","title":"Scene 2","scene_number":2,"slide_ids":["6DAYZylYZ4Y","6IcYxMXh0mW"]}],"slides":[{"id":"5mxvVHmgKIk","title":"Welcome","scene_id":"6RdIHQ8sw43","sequence_index":0,"lms_id":"Slide1","audio_count":0,"transcript_segments":[],"transcript_combined":"","concept_ids":[],"alt_text_corpus":"Lesson 3: Inverter Controls; Use this title layout.\\\\nIt is ok to change the background image as long as the EPRI gradient overlay remains on this page prominently displayed.\\\\nRemove audio track if the course does not contain any other audio. You may replace with different audio, especially if you are branding a series of courses. \\\\nAdd prerequisite or recommended prior course work or knowledge to this slide if needed.\\\\n\\\\nStart Course \\u2013 Trigger to jump to About This Course.\\\\n; title.jpg; \\u00a9 2025 E"},{"id":"6ps7ro4Er5o","title":"Introduction","scene_id":"6RdIHQ8sw43","sequence_index":1,"lms_id":"Slide2","audio_count":2,"transcript_segments":[{"audio_url":"story_content/6XoiU1qYPis_44100_48_0.mp3","duration":28.578,"text":"It's important for transmission operations personnel to understand how IBR's synchronize to the grid and manage current voltage and power flows. IBR's use advanced electronics to control how they interact with the grid. In the last lesson, we focused on how to produce the desired voltage given a reference voltage. In this lesson, we'll focus on how the control system for the inverter produces the desired voltage set point based on the commands from the base level controller.","segments":[{"start":0.0,"end":5.5,"text":" It's important for transmission operations personnel to understand how IBR's synchronize"},{"start":5.5,"end":9.02,"text":" to the grid and manage current voltage and power flows."},{"start":9.02,"end":13.8,"text":" IBR's use advanced electronics to control how they interact with the grid."},{"start":13.8,"end":18.22,"text":" In the last lesson, we focused on how to produce the desired voltage given a reference"},{"start":18.22,"end":19.3,"text":" voltage."},{"start":19.3,"end":24.060000000000002,"text":" In this lesson, we'll focus on how the control system for the inverter produces the desired"},{"start":24.060000000000002,"end":28.060000000000002,"text":" voltage set point based on the commands from the base level controller."}]},{"audio_url":"story_content/5dLzuRNCmmT_44100_48_0.mp3","duration":9.6391875,"text":"Upon completion of this lesson, you should be able to describe key aspects of the various IBR control system options and be able to meet the learning objectives shown.","segments":[{"start":0.0,"end":5.04,"text":" Upon completion of this lesson, you should be able to describe key aspects of the various"},{"start":5.04,"end":9.24,"text":" IBR control system options and be able to meet the learning objectives shown."}]}],"transcript_combined":"It's important for transmission operations personnel to understand how IBR's synchronize to the grid and manage current voltage and power flows. IBR's use advanced electronics to control how they interact with the grid. In the last lesson, we focused on how to produce the desired voltage given a reference voltage. In this lesson, we'll focus on how the control system for the inverter produces the desired voltage set point based on the commands from the base level controller. Upon completion of this lesson, you should be able to describe key aspects of the various IBR control system options and be able to meet the learning objectives shown.","concept_ids":["voltage","desired-voltage","grid","system","important-for-transmission","transmission-operations-personnel","grid-and-manage","manage-current-voltage","power-and-voltage","power-flows-ibr","how-they-interact","produce-the-desired","produces-the-desired","desired-voltage-set","set-point-based","from-the-base","base-level-controller","level-controller-upon"],"alt_text_corpus":"Lesson 3 Focus; Image 37.emf; Rectangle 1; Lesson 2 Focus; Rectangle 2"},{"id":"5zBRyvxOwou","title":"Inverter Operating Principles","scene_id":"6RdIHQ8sw43","sequence_index":2,"lms_id":"Slide3","audio_count":2,"transcript_segments":[{"audio_url":"story_content/6qbFcOmxbpl_44100_48_0.mp3","duration":17.00575,"text":"To begin, let's review a few foundational inverter operating principles. A present day inverter connects to a network grid. The inverter and the network are different technologies, but the inverter control must follow the grid voltage, so that the inverter and grid are synchronized.","segments":[{"start":0.0,"end":5.0,"text":" To begin, let's review a few foundational inverter operating principles."},{"start":5.0,"end":8.0,"text":" A present day inverter connects to a network grid."},{"start":8.0,"end":11.0,"text":" The inverter and the network are different technologies,"},{"start":11.0,"end":14.0,"text":" but the inverter control must follow the grid voltage,"},{"start":14.0,"end":17.0,"text":" so that the inverter and grid are synchronized."}]},{"audio_url":"story_content/5pUWbRqZNS6_44100_48_0.mp3","duration":45.035125,"text":"As discussed in lesson two, the plant controller provides the set points for active and reactive power. The inverter must quickly and accurately estimate the frequency and the phase angle of grid voltage. This is achieved using a phase-locked loop or PLL. In addition, when the grid voltage changes, the inverter control needs to respond quickly to that change, accurately controlling its terminal current to generate the voltage reference. Simply put, the current injected by the inverter, determined by complex power divided by voltage, needs to match the current drawn by the network, voltage divided by impedance, to maintain the stable grid operation. Click each equation at the bottom of the page for additional information. Click next to continue.","segments":[{"start":0.0,"end":6.5,"text":" As discussed in lesson two, the plant controller provides the set points for active and reactive power."},{"start":6.5,"end":12.0,"text":" The inverter must quickly and accurately estimate the frequency and the phase angle of grid voltage."},{"start":12.0,"end":16.0,"text":" This is achieved using a phase-locked loop or PLL."},{"start":16.0,"end":22.0,"text":" In addition, when the grid voltage changes, the inverter control needs to respond quickly to that change,"},{"start":22.0,"end":26.0,"text":" accurately controlling its terminal current to generate the voltage reference."},{"start":26.0,"end":32.0,"text":" Simply put, the current injected by the inverter, determined by complex power divided by voltage,"},{"start":32.0,"end":39.0,"text":" needs to match the current drawn by the network, voltage divided by impedance, to maintain the stable grid operation."},{"start":39.0,"end":43.0,"text":" Click each equation at the bottom of the page for additional information."},{"start":43.0,"end":45.0,"text":" Click next to continue."}]}],"transcript_combined":"To begin, let's review a few foundational inverter operating principles. A present day inverter connects to a network grid. The inverter and the network are different technologies, but the inverter control must follow the grid voltage, so that the inverter and grid are synchronized. As discussed in lesson two, the plant controller provides the set points for active and reactive power. The inverter must quickly and accurately estimate the frequency and the phase angle of grid voltage. This is achieved using a phase-locked loop or PLL. In addition, when the grid voltage changes, the inverter control needs to respond quickly to that change, accurately controlling its terminal current to generate the voltage reference. Simply put, the current injected by the inverter, determined by complex power divided by voltage, needs to match the current drawn by the network, voltage divided by impedance, to maintain the stable grid operation. Click each equation at the bottom of the page for additional information. Click next to continue.","concept_ids":["inverter","grid","voltage","grid-voltage","inverter-operating-principles","current","power","foundational-inverter-operating","present-day-inverter","day-inverter-connects","grid-the-inverter","follow-the-grid","inverter-and-grid","grid-are-synchronized","plant-controller-provides","provides-the-set"],"alt_text_corpus":"Rectangle 13; Rectangle 3; Rectangle 12; Rectangle 2; Rectangle 5; Rectangle 1; Down Arrow 1; Click each equation to see what it represents; Rectangle 4; Down Arrow 2"},{"id":"6eVptVTR2Lx","title":"Current Control Overview","scene_id":"6RdIHQ8sw43","sequence_index":3,"lms_id":"Slide4","audio_count":2,"transcript_segments":[{"audio_url":"story_content/68UQ9jgrgX0_44100_48_0.mp3","duration":15.51675,"text":"The objective of Inverter Control is to control the output current of the inverter by using the measured and transformed current and measured and transformed voltage as inputs. The output is the voltage reference or modulating signal for the PWM scheme.","segments":[{"start":0.0,"end":10.0,"text":" The objective of Inverter Control is to control the output current of the inverter by using the measured and transformed current and measured and transformed voltage as inputs."},{"start":10.0,"end":15.0,"text":" The output is the voltage reference or modulating signal for the PWM scheme."}]},{"audio_url":"story_content/6llp0vzR9dL_44100_48_0.mp3","duration":28.8130625,"text":"The inverter control achieves the subjective through a nested loop structure. You learned about this flow in lesson 2, but let's review. The plant controller provides the desired active and reactive power set points to the inverter control. Sensors measure the voltage. The outer loop provides the reference currents which the inner loop uses to generate the reference voltage. This voltage reference is processed by the PWM scheme to generate the system reference voltage E.","segments":[{"start":0.0,"end":4.76,"text":" The inverter control achieves the subjective through a nested loop structure."},{"start":4.76,"end":8.2,"text":" You learned about this flow in lesson 2, but let's review."},{"start":8.2,"end":13.24,"text":" The plant controller provides the desired active and reactive power set points to the inverter"},{"start":13.24,"end":14.24,"text":" control."},{"start":14.24,"end":16.2,"text":" Sensors measure the voltage."},{"start":16.2,"end":20.32,"text":" The outer loop provides the reference currents which the inner loop uses to generate"},{"start":20.32,"end":22.0,"text":" the reference voltage."},{"start":22.0,"end":27.68,"text":" This voltage reference is processed by the PWM scheme to generate the system reference voltage"},{"start":27.68,"end":28.0,"text":" E."}]}],"transcript_combined":"The objective of Inverter Control is to control the output current of the inverter by using the measured and transformed current and measured and transformed voltage as inputs. The output is the voltage reference or modulating signal for the PWM scheme. The inverter control achieves the subjective through a nested loop structure. You learned about this flow in lesson 2, but let's review. The plant controller provides the desired active and reactive power set points to the inverter control. Sensors measure the voltage. The outer loop provides the reference currents which the inner loop uses to generate the reference voltage. This voltage reference is processed by the PWM scheme to generate the system reference voltage E.","concept_ids":["voltage","inverter","measured-and-transformed","pwm-scheme","current","loop","output","current-and-measured","inputs-the-output","scheme-the-inverter","inverter-control-achieves","achieves-the-subjective","nested-loop-structure","structure-you-learned","2-but-let","plant-controller-provides","provides-the-desired","active-and-reactive"],"alt_text_corpus":"Control output current of the inverter:; Image 38.emf; Rectangle 3; Up Arrow 2; Inverter Control Objective; Up Arrow 1; Inverter Control Objective\\\\nControl output current of the inverter: \\\\nUsing measured and transformed current, i\\\\nUsing measured and transformed voltage, Vt; Rectangle 1; Using measured and transformed current, i; Rectangle 4; Using measured and transformed voltage, Vt; Rectangle 2"},{"id":"5q1PTTjK3aS","title":"Power and Voltage Control Overview","scene_id":"6RdIHQ8sw43","sequence_index":4,"lms_id":"Slide5","audio_count":1,"transcript_segments":[{"audio_url":"story_content/5x2cQjOSedu_44100_48_0.mp3","duration":21.0285625,"text":"Now that we've discussed current control, let's discuss power and voltage control. Power control is dependent on the primary power source. The inverter controls DC voltage while terminal voltage depends on both the inverter and how the system is reacting to it. Click next to look in more depth at active and reactive power control.","segments":[{"start":0.0,"end":5.6000000000000005,"text":" Now that we've discussed current control, let's discuss power and voltage control."},{"start":5.6000000000000005,"end":9.24,"text":" Power control is dependent on the primary power source."},{"start":9.24,"end":14.44,"text":" The inverter controls DC voltage while terminal voltage depends on both the inverter and"},{"start":14.44,"end":16.8,"text":" how the system is reacting to it."},{"start":16.8,"end":20.44,"text":" Click next to look in more depth at active and reactive power control."}]}],"transcript_combined":"Now that we've discussed current control, let's discuss power and voltage control. Power control is dependent on the primary power source. The inverter controls DC voltage while terminal voltage depends on both the inverter and how the system is reacting to it. Click next to look in more depth at active and reactive power control.","concept_ids":["power","voltage","power-and-voltage","inverter","current-control-let","voltage-control-power","primary-power-source","source-the-inverter","voltage-while-terminal","terminal-voltage-depends","inverter-and-how","how-the-system","active-and-reactive","discussed-current","reactive-power"],"alt_text_corpus":"Rectangle 6; Voltage Control; Rectangle 3; Rectangle 5; Power Control; Rectangle 1; Rectangle 4; Rectangle 2"},{"id":"6KhIqryeG83","title":"Active and Reactive Power Control","scene_id":"6RdIHQ8sw43","sequence_index":5,"lms_id":"Slide6","audio_count":3,"transcript_segments":[{"audio_url":"story_content/6Uhqd0AwLft_44100_48_0.mp3","duration":36.258,"text":"There are two common approaches for managing DC voltage so that the inverter's output voltage is synchronized with the grid. In one approach, the primary power source controls active power while the inverter regulates DC voltage. In the other approach, the source controls DC voltage and the inverter manages active power. We'll focus on the first approach. This approach is used, for example, in a maximum PPS tracking scheme where the maximum power is extracted from the primary power source. Click each button to learn how active and reactive power control systems are implemented.","segments":[{"start":0.0,"end":5.76,"text":" There are two common approaches for managing DC voltage so that the inverter's output voltage"},{"start":5.76,"end":8.040000000000001,"text":" is synchronized with the grid."},{"start":8.040000000000001,"end":12.68,"text":" In one approach, the primary power source controls active power while the inverter regulates"},{"start":12.68,"end":14.48,"text":" DC voltage."},{"start":14.48,"end":19.12,"text":" In the other approach, the source controls DC voltage and the inverter manages active"},{"start":19.12,"end":20.12,"text":" power."},{"start":20.12,"end":22.28,"text":" We'll focus on the first approach."},{"start":22.28,"end":27.080000000000002,"text":" This approach is used, for example, in a maximum PPS tracking scheme where the maximum"},{"start":27.080000000000002,"end":30.720000000000002,"text":" power is extracted from the primary power source."},{"start":30.720000000000002,"end":35.24,"text":" Click each button to learn how active and reactive power control systems are implemented."}]},{"audio_url":"story_content/5gtwDF7sBFF_44100_48_0.mp3","duration":27.4285625,"text":"Reactive power can be controlled in open loop or closed loop. With open loop control, the reference set point for reactive current is determined based on the reactive power set point and the voltage measurement. So Q, reactive power divided by Vd, voltage gives the reactive reference current. With closed loop control, the reference reactive power is compared to the measured reactive power and then a compensator generates the reactive reference current.","segments":[{"start":0.0,"end":4.6000000000000005,"text":" Reactive power can be controlled in open loop or closed loop."},{"start":4.6000000000000005,"end":8.68,"text":" With open loop control, the reference set point for reactive current is determined based"},{"start":8.68,"end":12.24,"text":" on the reactive power set point and the voltage measurement."},{"start":12.24,"end":18.76,"text":" So Q, reactive power divided by Vd, voltage gives the reactive reference current."},{"start":18.76,"end":22.64,"text":" With closed loop control, the reference reactive power is compared to the measured"},{"start":22.64,"end":26.64,"text":" reactive power and then a compensator generates the reactive reference current."}]},{"audio_url":"story_content/6Rv8igKXCV7_44100_48_0.mp3","duration":46.053875,"text":"Let's examine two DC control approaches used to determine the amount of active power. In the first approach, control is based on DC-voltage squared control, where VDC squared control develops an active power reference. This reference can then be used for either closed loop active power control or open loop control by calculating a current reference. This approach is more commonly used in bulk renewable generation inverters and more accurately produces controllable power output. The second DC voltage control approach controls VDC directly by developing the current reference to maintain the desired voltage level. This approach is more easily used in distribution-connected distributed energy resources or DER.","segments":[{"start":0.0,"end":6.6000000000000005,"text":" Let's examine two DC control approaches used to determine the amount of active power."},{"start":6.6000000000000005,"end":12.24,"text":" In the first approach, control is based on DC-voltage squared control, where VDC squared"},{"start":12.24,"end":15.44,"text":" control develops an active power reference."},{"start":15.44,"end":19.88,"text":" This reference can then be used for either closed loop active power control or open"},{"start":19.88,"end":23.2,"text":" loop control by calculating a current reference."},{"start":23.2,"end":28.12,"text":" This approach is more commonly used in bulk renewable generation inverters and more accurately"},{"start":28.12,"end":31.0,"text":" produces controllable power output."},{"start":31.0,"end":36.160000000000004,"text":" The second DC voltage control approach controls VDC directly by developing the current"},{"start":36.160000000000004,"end":39.32,"text":" reference to maintain the desired voltage level."},{"start":39.32,"end":44.28,"text":" This approach is more easily used in distribution-connected distributed energy resources"},{"start":44.28,"end":45.24,"text":" or DER."}]}],"transcript_combined":"There are two common approaches for managing DC voltage so that the inverter's output voltage is synchronized with the grid. In one approach, the primary power source controls active power while the inverter regulates DC voltage. In the other approach, the source controls DC voltage and the inverter manages active power. We'll focus on the first approach. This approach is used, for example, in a maximum PPS tracking scheme where the maximum power is extracted from the primary power source. Click each button to learn how active and reactive power control systems are implemented. Reactive power can be controlled in open loop or closed loop. With open loop control, the reference set point for reactive current is determined based on the reactive power set point and the voltage measurement. So Q, reactive power divided by Vd, voltage gives the reactive reference current. With closed loop control, the reference reactive power is compared to the measured reactive power and then a compensator generates the reactive reference current. Let's examine two DC control approaches used to determine the amount of active power. In the first approach, control is based on DC-voltage squared control, where VDC squared control develops an active power reference. This reference can then be used for either closed loop active power control or open loop control by calculating a current reference. This approach is more commonly used in bulk renewable generation inverters and more accurately produces controllable power output. The second DC voltage control approach controls VDC directly by developing the current reference to maintain the desired voltage level. This approach is more easily used in distribution-connected distributed energy resources or DER.","concept_ids":["power","reactive-power","voltage","active-power","loop","current","closed-loop","active-and-reactive","primary-power-source","reactive-reference-current","inverter","output","approaches-for-managing"],"alt_text_corpus":"Approach 2:  PPS controls dc voltage and the inverter manages active power.; Image 42.emf; Rectangle 7; Rectangle 8; Closed Loop; Rectangle 2; Reactive power reference (Q*ppc) from the plant controller to the inverter; Rectangle 6; Rectangle 10; Rectangle 5; Active Power; Image 45.emf; Image 44.emf; Simpler and more easily used in distribution-connected DER.; Reactive Power; Approach 1:  Primary power source (PPS) controls active power and the inverter controls Vdc.; More commonly used in bulk r"},{"id":"6cuGuY88hng","title":"Voltage Control","scene_id":"6RdIHQ8sw43","sequence_index":6,"lms_id":"Slide7","audio_count":6,"transcript_segments":[{"audio_url":"story_content/6JiqSURUYvI_44100_48_0.mp3","duration":15.177125,"text":"As you learned earlier, terminal voltage is dependent on both the inverter and how the system is reacting to it. We assume that the inverter autonomously measures and regulates terminal voltage locally without receiving a voltage reference point from the plant controller.","segments":[{"start":0.0,"end":7.0,"text":" As you learned earlier, terminal voltage is dependent on both the inverter and how the system is reacting to it."},{"start":7.0,"end":15.0,"text":" We assume that the inverter autonomously measures and regulates terminal voltage locally without receiving a voltage reference point from the plant controller."}]},{"audio_url":"story_content/5ZIVqtC2X4g_44100_48_0.mp3","duration":39.915125,"text":"Inverter voltage is controlled through reactive current. To understand how the inverter develops the reactive current reference in the dynamics, we can use Kirchhoff's voltage law to calculate the system voltage, VTD1. The equation shows that the active current component of the terminal voltage depends on several terms. Note that the parameter LG which represents the grid inductance and is an indication of the short circuit strength of the grid appears in two of those terms. This suggests that the dynamics of VTD1 depends on grid strength. Click each component of the equation that contributes to system voltage to learn more. Click next to continue.","segments":[{"start":0.0,"end":3.6,"text":" Inverter voltage is controlled through reactive current."},{"start":3.6,"end":8.0,"text":" To understand how the inverter develops the reactive current reference in the dynamics,"},{"start":8.0,"end":13.5,"text":" we can use Kirchhoff's voltage law to calculate the system voltage, VTD1."},{"start":13.5,"end":17.8,"text":" The equation shows that the active current component of the terminal voltage depends on"},{"start":17.8,"end":19.3,"text":" several terms."},{"start":19.3,"end":24.400000000000002,"text":" Note that the parameter LG which represents the grid inductance and is an indication"},{"start":24.400000000000002,"end":28.7,"text":" of the short circuit strength of the grid appears in two of those terms."},{"start":28.7,"end":33.2,"text":" This suggests that the dynamics of VTD1 depends on grid strength."},{"start":33.2,"end":37.7,"text":" Click each component of the equation that contributes to system voltage to learn more."},{"start":37.7,"end":39.7,"text":" Click next to continue."}]},{"audio_url":"story_content/6I0VR61PQcO_44100_48_0.mp3","duration":49.2408125,"text":"The last term in the equation is system voltage. The presence of the term LG in voltage dynamics makes voltage control dependent on grid strength. The graph shows the step response of the terminal voltage for different grid short circuit ratio or SCR values with the same controller gain. In weaker grid conditions, for example, a short circuit ratio of 2 to 5, the response is faster. However, as the grid gets stronger, for example, a short circuit ratio of 10 to 15, the response slows down because LG is larger and it takes more reactive current to change voltage. In summary, the IBR response is dependent upon both its internal control system and the grid strength at its connection point. The graph of the voltage response at different SCR values is extremely telling.","segments":[{"start":0.0,"end":3.5,"text":" The last term in the equation is system voltage."},{"start":3.5,"end":6.96,"text":" The presence of the term LG in voltage dynamics makes"},{"start":6.96,"end":9.8,"text":" voltage control dependent on grid strength."},{"start":9.8,"end":13.040000000000001,"text":" The graph shows the step response of the terminal voltage"},{"start":13.040000000000001,"end":16.32,"text":" for different grid short circuit ratio or SCR values"},{"start":16.32,"end":18.3,"text":" with the same controller gain."},{"start":18.3,"end":20.6,"text":" In weaker grid conditions, for example,"},{"start":20.6,"end":24.400000000000002,"text":" a short circuit ratio of 2 to 5, the response is faster."},{"start":24.400000000000002,"end":26.6,"text":" However, as the grid gets stronger,"},{"start":26.6,"end":29.900000000000002,"text":" for example, a short circuit ratio of 10 to 15,"},{"start":29.900000000000002,"end":32.800000000000004,"text":" the response slows down because LG is larger"},{"start":32.800000000000004,"end":36.2,"text":" and it takes more reactive current to change voltage."},{"start":36.2,"end":40.2,"text":" In summary, the IBR response is dependent upon both its internal"},{"start":40.2,"end":43.900000000000006,"text":" control system and the grid strength at its connection point."},{"start":43.900000000000006,"end":47.0,"text":" The graph of the voltage response at different SCR values"},{"start":47.0,"end":49.0,"text":" is extremely telling."}]},{"audio_url":"story_content/5jMp1uOBvcw_44100_48_0.mp3","duration":24.9469375,"text":"LG Omega PLLIQ1 represents a voltage across the system inductance due to the rotating reference frame or changing frequency. LG or grid-side inductance can take on a range of values based on system conditions. In a weak grid where LG is large, a small change in reactive current can cause a large change in voltage. This can affect the controller's performance.","segments":[{"start":0.0,"end":9.0,"text":" LG Omega PLLIQ1 represents a voltage across the system inductance due to the rotating reference frame or changing frequency."},{"start":9.0,"end":15.0,"text":" LG or grid-side inductance can take on a range of values based on system conditions."},{"start":15.0,"end":22.0,"text":" In a weak grid where LG is large, a small change in reactive current can cause a large change in voltage."},{"start":22.0,"end":25.0,"text":" This can affect the controller's performance."}]},{"audio_url":"story_content/6SypeIXvavu_44100_48_0.mp3","duration":24.293875,"text":"This part of the equation represents the voltage drop due to system inductance and the change rate of the active current. In a weak grid, after a fault, we aim to limit the ramp rate of the active current component, DID1, by DT to avoid rapid changes in ID1 that could lead to undesirable large changes in voltage. LG may take on a range of values based on system conditions.","segments":[{"start":0.0,"end":7.0,"text":" This part of the equation represents the voltage drop due to system inductance and the change rate of the active current."},{"start":7.0,"end":12.0,"text":" In a weak grid, after a fault, we aim to limit the ramp rate of the active current component,"},{"start":12.0,"end":20.0,"text":" DID1, by DT to avoid rapid changes in ID1 that could lead to undesirable large changes in voltage."},{"start":20.0,"end":24.0,"text":" LG may take on a range of values based on system conditions."}]},{"audio_url":"story_content/5nckAIutyat_44100_48_0.mp3","duration":43.0236875,"text":"This part of the equation represents voltage drop due to system resistance. Rg is the resistive part of the grid impedance. ID references active power current. In transmission applications, we can assume that the resistive part of grid impedance R is a negligible component of the overall impedance x. Hence, we can ignore Rgid with in voltage dynamics. This suggests that the terminal voltage can be controlled by the reactive current. Looking at the voltage control system, the reference voltage is compared to the measured voltage and the difference is processed by a compensator to develop the reference current. The compensator is typically a proportional integrator controller.","segments":[{"start":0.0,"end":4.96,"text":" This part of the equation represents voltage drop due to system resistance."},{"start":4.96,"end":8.5,"text":" Rg is the resistive part of the grid impedance."},{"start":8.5,"end":11.4,"text":" ID references active power current."},{"start":11.4,"end":16.14,"text":" In transmission applications, we can assume that the resistive part of grid impedance"},{"start":16.14,"end":20.22,"text":" R is a negligible component of the overall impedance x."},{"start":20.22,"end":24.32,"text":" Hence, we can ignore Rgid with in voltage dynamics."},{"start":24.32,"end":28.560000000000002,"text":" This suggests that the terminal voltage can be controlled by the reactive current."},{"start":28.8,"end":33.84,"text":" Looking at the voltage control system, the reference voltage is compared to the measured voltage"},{"start":33.84,"end":38.5,"text":" and the difference is processed by a compensator to develop the reference current."},{"start":38.5,"end":42.36,"text":" The compensator is typically a proportional integrator controller."}]}],"transcript_combined":"As you learned earlier, terminal voltage is dependent on both the inverter and how the system is reacting to it. We assume that the inverter autonomously measures and regulates terminal voltage locally without receiving a voltage reference point from the plant controller. Inverter voltage is controlled through reactive current. To understand how the inverter develops the reactive current reference in the dynamics, we can use Kirchhoff's voltage law to calculate the system voltage, VTD1. The equation shows that the active current component of the terminal voltage depends on several terms. Note that the parameter LG which represents the grid inductance and is an indication of the short circuit strength of the grid appears in two of those terms. This suggests that the dynamics of VTD1 depends on grid strength. Click each component of the equation that contributes to system voltage to learn more. Click next to continue. The last term in the equation is system voltage. The presence of the term LG in voltage dynamics makes voltage control dependent on grid strength. The graph shows the step response of the terminal voltage for different grid short circuit ratio or SCR values with the same controller gain. In weaker grid conditions, for example, a short circuit ratio of 2 to 5, the response is faster. However, as the grid gets stronger, for example, a short circuit ratio of 10 to 15, the response slows down because LG is larger and it takes more reactive current to change voltage. In summary, the IBR response is dependent upon both its internal control system and the grid strength at its connection point. The graph of the voltage response at different SCR values is extremely telling. LG Omega PLLIQ1 represents a voltage across the system inductance due to the rotating reference frame or changing frequency. LG or grid-side inductance can take on a range of values based on system conditions. In a weak grid where LG is large, a small change in reactive current can cause a large change in voltage. This can affect the controller's performance. This part of the equation represents the voltage drop due to system inductance and the change rate of the active current. In a weak grid, after a fault, we aim to limit the ramp rate of the active current component, DID1, by DT to avoid rapid changes in ID1 that could lead to undesirable large changes in voltage. LG may take on a range of values based on system conditions. This part of the equation represents voltage drop due to system resistance. Rg is the resistive part of the grid impedance. ID references active power current. In transmission applications, we can assume that the resistive part of grid impedance R is a negligible component of the overall impedance x. Hence, we can ignore Rgid with in voltage dynamics. This suggests that the terminal voltage can be controlled by the reactive current. Looking at the voltage control system, the reference voltage is compared to the measured voltage and the difference is processed by a compensator to develop the reference current. The compensator is typically a proportional integrator controller.","concept_ids":["voltage","grid","system","current","terminal-voltage","reactive-current","short-circuit","short-circuit-ratio","response","system-voltage","active-current","grid-strength","inverter"],"alt_text_corpus":"Rectangle 7; voltage drop across the system inductance due to the rotating reference frame; Rectangle 8; Image 49.png; Rgid1 voltage drop due to system resistance; For transmission, assume impedance (X)>> resistance (R); Rectangle 6; Image 52.emf; It is common to limit recovery rate of id1; IBR response is dependent on:; Rectangle 5; Required to account for voltage drops due to changing frequency. \\\\nNote:  Lg may take on a range of values based on system conditions.; Image 48.png; Vgd - System V"},{"id":"6JZsAHMHpvb","title":"Fault Ride-Through Response (FRT)","scene_id":"6RdIHQ8sw43","sequence_index":7,"lms_id":"Slide8","audio_count":2,"transcript_segments":[{"audio_url":"story_content/64w1SoQq2BD_44100_48_0.mp3","duration":33.43675,"text":"So far we've discussed control under normal operating conditions where voltage and frequency are within the normal range and the plant controller generates set points for individual inverters. What do control objectives look like during abnormal conditions such as a fault where the voltage is fallen outside the normal range? When grid voltage is abnormally low or high, the inverter operates in low voltage drive through or high voltage drive through control mode. The plant controls are typically frozen and the inverter control responds to its terminal voltage.","segments":[{"start":0.0,"end":5.6000000000000005,"text":" So far we've discussed control under normal operating conditions where voltage and frequency"},{"start":5.6000000000000005,"end":10.08,"text":" are within the normal range and the plant controller generates set points for individual"},{"start":10.08,"end":11.64,"text":" inverters."},{"start":11.64,"end":16.0,"text":" What do control objectives look like during abnormal conditions such as a fault where the"},{"start":16.0,"end":19.48,"text":" voltage is fallen outside the normal range?"},{"start":19.48,"end":24.48,"text":" When grid voltage is abnormally low or high, the inverter operates in low voltage"},{"start":24.48,"end":27.76,"text":" drive through or high voltage drive through control mode."},{"start":27.76,"end":32.24,"text":" The plant controls are typically frozen and the inverter control responds to its terminal"},{"start":32.24,"end":32.84,"text":" voltage."}]},{"audio_url":"story_content/6O98E7I3oiU_44100_48_0.mp3","duration":9.247375,"text":"Click on each photo to learn about some control objectives for a fault ride through response. Click next when you have finished to continue to a lesson summary.","segments":[{"start":0.0,"end":5.0,"text":" Click on each photo to learn about some control objectives for a fault ride through response."},{"start":5.0,"end":9.0,"text":" Click next when you have finished to continue to a lesson summary."}]}],"transcript_combined":"So far we've discussed control under normal operating conditions where voltage and frequency are within the normal range and the plant controller generates set points for individual inverters. What do control objectives look like during abnormal conditions such as a fault where the voltage is fallen outside the normal range? When grid voltage is abnormally low or high, the inverter operates in low voltage drive through or high voltage drive through control mode. The plant controls are typically frozen and the inverter control responds to its terminal voltage. Click on each photo to learn about some control objectives for a fault ride through response. Click next when you have finished to continue to a lesson summary.","concept_ids":["voltage","normal-range","voltage-drive","response","inverter","fault-ride-through-response","ride-through-response-frt","normal-operating-conditions","conditions-where-voltage","voltage-and-frequency","plant-controller-generates","controller-generates-set","generates-set-points","points-for-individual","individual-inverters-what"],"alt_text_corpus":"Control Objectives; Inject reactive current to support the voltage - either positive or negative sequence; Image 38.emf; Rectangle 1; Have fast response time - tens of milliseconds -- based on the agreed code and interconnection requirements; Maintain current limits of the power electronics \\\\nControl dc voltage\\\\nInject reactive current to keep phase current between 1.1 - 1.5; Rectangle 4; Rectangle 2"},{"id":"66RtiTQPuzj","title":"Conclusion","scene_id":"6RdIHQ8sw43","sequence_index":8,"lms_id":"Slide9","audio_count":3,"transcript_segments":[{"audio_url":"story_content/5jKG5HVuxEz_44100_48_0.mp3","duration":6.373875,"text":"You have now completed the third lesson of the Inverter-based Resource Basics and Operations course.","segments":[{"start":0.0,"end":6.0,"text":" You have now completed the third lesson of the Inverter-based Resource Basics and Operations course."}]},{"audio_url":"story_content/6Yj2OVM5BXp_44100_48_0.mp3","duration":16.58775,"text":"In this lesson, you reviewed some basic inverter operating principles. You were introduced to control objectives used in normal conditions for current, outer loop, reactive power and voltage controls. You also reviewed some control objectives for a fault ride-through response.","segments":[{"start":0.0,"end":5.0,"text":" In this lesson, you reviewed some basic inverter operating principles."},{"start":5.0,"end":9.8,"text":" You were introduced to control objectives used in normal conditions for current, outer loop,"},{"start":9.8,"end":12.3,"text":" reactive power and voltage controls."},{"start":12.3,"end":16.0,"text":" You also reviewed some control objectives for a fault ride-through response."}]},{"audio_url":"story_content/60Wi5ALwlLq_44100_48_0.mp3","duration":7.1575625,"text":"You should now be able to describe key aspects of the various IBR control system options covered in this lesson.","segments":[{"start":0.0,"end":7.0,"text":" You should now be able to describe key aspects of the various IBR control system options covered in this lesson."}]}],"transcript_combined":"You have now completed the third lesson of the Inverter-based Resource Basics and Operations course. In this lesson, you reviewed some basic inverter operating principles. You were introduced to control objectives used in normal conditions for current, outer loop, reactive power and voltage controls. You also reviewed some control objectives for a fault ride-through response. You should now be able to describe key aspects of the various IBR control system options covered in this lesson.","concept_ids":["inverter-based-resource-basics","basics-and-operations","reviewed-some-basic","basic-inverter-operating","inverter-operating-principles","conditions-for-current","current-outer-loop","outer-loop-reactive","loop-reactive-power","power-and-voltage","fault-ride-through-response","ibr-control-system","system-options-covered","normal-conditions","various-ibr"],"alt_text_corpus":"AdobeStock_635174439.jpg; Image 38.emf; You have now completed Lesson 3: Inverter Controls; Rectangle 1; Rectangle 2"},{"id":"5XHGBaZwOfD","title":"Thank You","scene_id":"6RdIHQ8sw43","sequence_index":9,"lms_id":"Slide10","audio_count":1,"transcript_segments":[{"audio_url":"story_content/5lCm0CvEUym_44100_48_0.mp3","duration":60.029375,"text":"Thank you.","segments":[{"start":0.0,"end":19.72,"text":" Thank you."}]}],"transcript_combined":"Thank you.","concept_ids":[],"alt_text_corpus":"Instructions for Developer:\\\\n\\\\nThis slide must be included in all courses.\\\\nThis slide must contain the course title, the EPRI U graphic, and an Exit button.\\\\nThe background image and other features can be changed to fit each course.\\\\nRemove the music if the course does not contain audio, or change the music if desired.; Thank you for your participation in \\\\nLesson 3: Inverter Controls.\\\\n\\\\rSelect the Exit button to end this course.; EPRI training_editable backgrounds EXIT.jpg; Exit"},{"id":"6DAYZylYZ4Y","title":"Navigating This Course","scene_id":"5sFB072XEDS","sequence_index":0,"lms_id":"Slide1","audio_count":0,"transcript_segments":[],"transcript_combined":"","concept_ids":[],"alt_text_corpus":"Reference Materials; Screenshot (812).png; CC.png; Glossary; playback.png; Navigating This Course; Exit; Glossary.png; Full Screen Toggle allows you to minimize distractions by utilizing your entire screen to view the course. Select the button to toggle full screen on and off.; You can exit the course at any time by selecting the Exit button in the top right. If you return to the course at a later date, you can pick-up right where you left off. \\\\n\\\\nWhen you reach the end of the course, you will "},{"id":"6IcYxMXh0mW","title":"About This Course","scene_id":"5sFB072XEDS","sequence_index":1,"lms_id":"Slide2","audio_count":0,"transcript_segments":[],"transcript_combined":"","concept_ids":[],"alt_text_corpus":"This course contains audio ; no audio icon 1; \\\\t\\\\t\\\\t\\\\t      DISCLAIMER\\\\n\\\\nTHIS NOTICE MAY NOT BE REMOVED FROM THE PROGRAM BY ANY USER THEREOF.\\\\r\\\\nNEITHER EPRI, ANY MEMBER OF EPRI, NOR ANY PERSON OR ORGANIZATION ACTING ON BEHALF OF THEM:\\\\r\\\\nMAKES ANY WARRANTY OR REPRESENTATION WHATSOEVER, EXPRESS OR IMPLIED, INCLUDING ANY WARRANTY OF MERCHANTABILITY OR FITNESS OF ANY PURPOSE WITH RESPECT TO THE PROGRAM; OR\\\\r\\\\nASSUMES ANY LIABILITY WHATSOEVER WITH RESPECT TO ANY USE OF THE PROGRAM OR ANY PORTION T"}],"concepts":[{"id":"grid-voltage","label":"grid voltage","confidence":0.68,"tier":2,"taught_in_slides":["5zBRyvxOwou"],"total_freq":3},{"id":"inverter-based-resource-basics","label":"inverter-based resource basics","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"terminal-voltage-depends","label":"terminal voltage depends","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"how-the-system","label":"how the system","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"active-current","label":"active current","confidence":0.68,"tier":2,"taught_in_slides":["6cuGuY88hng"],"total_freq":3},{"id":"normal-operating-conditions","label":"normal operating conditions","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"conditions-where-voltage","label":"conditions where voltage","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"inverter-and-grid","label":"inverter and grid","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"short-circuit-ratio","label":"short circuit ratio","confidence":0.68,"tier":2,"taught_in_slides":["6cuGuY88hng"],"total_freq":3},{"id":"reactive-current","label":"reactive current","confidence":0.7,"tier":2,"taught_in_slides":["6cuGuY88hng"],"total_freq":5},{"id":"grid-the-inverter","label":"grid the inverter","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"inverter","label":"inverter","confidence":0.93,"tier":1,"taught_in_slides":["5zBRyvxOwou","6eVptVTR2Lx","5q1PTTjK3aS","6KhIqryeG83","6cuGuY88hng","6JZsAHMHpvb"],"total_freq":24},{"id":"voltage-control-power","label":"voltage control power","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"from-the-base","label":"from the base","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"important-for-transmission","label":"important for transmission","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"plant-controller-provides","label":"plant controller provides","confidence":0.88,"tier":1,"taught_in_slides":["5zBRyvxOwou","6eVptVTR2Lx"],"total_freq":2},{"id":"closed-loop","label":"closed loop","confidence":0.68,"tier":2,"taught_in_slides":["6KhIqryeG83"],"total_freq":3},{"id":"grid","label":"grid","confidence":0.91,"tier":1,"taught_in_slides":["6ps7ro4Er5o","5zBRyvxOwou","6cuGuY88hng"],"total_freq":20},{"id":"grid-and-manage","label":"grid and manage","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"system-voltage","label":"system voltage","confidence":0.68,"tier":2,"taught_in_slides":["6cuGuY88hng"],"total_freq":3},{"id":"primary-power-source","label":"primary power source","confidence":0.89,"tier":1,"taught_in_slides":["5q1PTTjK3aS","6KhIqryeG83"],"total_freq":3},{"id":"provides-the-desired","label":"provides the desired","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"basics-and-operations","label":"basics and operations","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"individual-inverters-what","label":"individual inverters what","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"reactive-power","label":"reactive power","confidence":0.91,"tier":1,"taught_in_slides":["5q1PTTjK3aS","6KhIqryeG83"],"total_freq":8},{"id":"level-controller-upon","label":"level controller upon","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"terminal-voltage","label":"terminal voltage","confidence":0.7,"tier":2,"taught_in_slides":["6cuGuY88hng"],"total_freq":5},{"id":"short-circuit","label":"short circuit","confidence":0.69,"tier":2,"taught_in_slides":["6cuGuY88hng"],"total_freq":4},{"id":"follow-the-grid","label":"follow the grid","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"conditions-for-current","label":"conditions for current","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"2-but-let","label":"2 but let","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"loop-reactive-power","label":"loop reactive power","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"various-ibr","label":"various ibr","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"ride-through-response-frt","label":"ride-through response frt","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"fault-ride-through-response","label":"fault ride-through response","confidence":0.88,"tier":1,"taught_in_slides":["6JZsAHMHpvb","66RtiTQPuzj"],"total_freq":2},{"id":"current","label":"current","confidence":0.92,"tier":1,"taught_in_slides":["5zBRyvxOwou","6eVptVTR2Lx","6KhIqryeG83","6cuGuY88hng"],"total_freq":21},{"id":"inputs-the-output","label":"inputs the output","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"set-point-based","label":"set point based","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"controller-generates-set","label":"controller generates set","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"voltage-and-frequency","label":"voltage and frequency","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"current-and-measured","label":"current and measured","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"ibr-control-system","label":"ibr control system","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"reactive-reference-current","label":"reactive reference current","confidence":0.67,"tier":2,"taught_in_slides":["6KhIqryeG83"],"total_freq":2},{"id":"outer-loop-reactive","label":"outer loop reactive","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"basic-inverter-operating","label":"basic inverter operating","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"system","label":"system","confidence":0.91,"tier":1,"taught_in_slides":["6ps7ro4Er5o","6cuGuY88hng"],"total_freq":13},{"id":"grid-are-synchronized","label":"grid are synchronized","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"day-inverter-connects","label":"day inverter connects","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"voltage","label":"voltage","confidence":0.93,"tier":1,"taught_in_slides":["6ps7ro4Er5o","5zBRyvxOwou","6eVptVTR2Lx","5q1PTTjK3aS","6KhIqryeG83","6cuGuY88hng","6JZsAHMHpvb"],"total_freq":59},{"id":"discussed-current","label":"discussed current","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"foundational-inverter-operating","label":"foundational inverter operating","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"system-options-covered","label":"system options covered","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"normal-range","label":"normal range","confidence":0.67,"tier":2,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":2},{"id":"source-the-inverter","label":"source the inverter","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"present-day-inverter","label":"present day inverter","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"inverter-control-achieves","label":"inverter control achieves","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"inverter-operating-principles","label":"inverter operating principles","confidence":0.89,"tier":1,"taught_in_slides":["5zBRyvxOwou","66RtiTQPuzj"],"total_freq":3},{"id":"power-and-voltage","label":"power and voltage","confidence":0.9,"tier":1,"taught_in_slides":["6ps7ro4Er5o","5q1PTTjK3aS","66RtiTQPuzj"],"total_freq":4},{"id":"voltage-while-terminal","label":"voltage while terminal","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"power","label":"power","confidence":0.91,"tier":1,"taught_in_slides":["5zBRyvxOwou","5q1PTTjK3aS","6KhIqryeG83"],"total_freq":23},{"id":"power-flows-ibr","label":"power flows ibr","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"structure-you-learned","label":"structure you learned","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"active-power","label":"active power","confidence":0.7,"tier":2,"taught_in_slides":["6KhIqryeG83"],"total_freq":5},{"id":"grid-strength","label":"grid strength","confidence":0.68,"tier":2,"taught_in_slides":["6cuGuY88hng"],"total_freq":3},{"id":"generates-set-points","label":"generates set points","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"response","label":"response","confidence":0.91,"tier":1,"taught_in_slides":["6cuGuY88hng","6JZsAHMHpvb"],"total_freq":7},{"id":"inverter-and-how","label":"inverter and how","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"current-control-let","label":"current control let","confidence":0.46,"tier":3,"taught_in_slides":["5q1PTTjK3aS"],"total_freq":1},{"id":"loop","label":"loop","confidence":0.91,"tier":1,"taught_in_slides":["6eVptVTR2Lx","6KhIqryeG83"],"total_freq":9},{"id":"points-for-individual","label":"points for individual","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"transmission-operations-personnel","label":"transmission operations personnel","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"measured-and-transformed","label":"measured and transformed","confidence":0.67,"tier":2,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":2},{"id":"approaches-for-managing","label":"approaches for managing","confidence":0.46,"tier":3,"taught_in_slides":["6KhIqryeG83"],"total_freq":1},{"id":"desired-voltage-set","label":"desired voltage set","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"active-and-reactive","label":"active and reactive","confidence":0.9,"tier":1,"taught_in_slides":["6eVptVTR2Lx","5q1PTTjK3aS","6KhIqryeG83"],"total_freq":4},{"id":"plant-controller-generates","label":"plant controller generates","confidence":0.46,"tier":3,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":1},{"id":"achieves-the-subjective","label":"achieves the subjective","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"reviewed-some-basic","label":"reviewed some basic","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"provides-the-set","label":"provides the set","confidence":0.46,"tier":3,"taught_in_slides":["5zBRyvxOwou"],"total_freq":1},{"id":"voltage-drive","label":"voltage drive","confidence":0.67,"tier":2,"taught_in_slides":["6JZsAHMHpvb"],"total_freq":2},{"id":"output","label":"output","confidence":0.9,"tier":1,"taught_in_slides":["6eVptVTR2Lx","6KhIqryeG83"],"total_freq":4},{"id":"manage-current-voltage","label":"manage current voltage","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"how-they-interact","label":"how they interact","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"current-outer-loop","label":"current outer loop","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"produces-the-desired","label":"produces the desired","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"desired-voltage","label":"desired voltage","confidence":0.67,"tier":2,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":2},{"id":"pwm-scheme","label":"pwm scheme","confidence":0.67,"tier":2,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":2},{"id":"scheme-the-inverter","label":"scheme the inverter","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1},{"id":"produce-the-desired","label":"produce the desired","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"normal-conditions","label":"normal conditions","confidence":0.46,"tier":3,"taught_in_slides":["66RtiTQPuzj"],"total_freq":1},{"id":"base-level-controller","label":"base level controller","confidence":0.46,"tier":3,"taught_in_slides":["6ps7ro4Er5o"],"total_freq":1},{"id":"nested-loop-structure","label":"nested loop structure","confidence":0.46,"tier":3,"taught_in_slides":["6eVptVTR2Lx"],"total_freq":1}],"prereq_edges":[{"from":"grid","to":"inverter","confidence":0.57},{"from":"grid","to":"grid-voltage","confidence":0.48},{"from":"grid","to":"inverter-operating-principles","confidence":0.48},{"from":"grid","to":"current","confidence":0.57},{"from":"grid","to":"power","confidence":0.48},{"from":"grid","to":"foundational-inverter-operating","confidence":0.48},{"from":"grid","to":"present-day-inverter","confidence":0.48},{"from":"grid","to":"day-inverter-connects","confidence":0.48},{"from":"grid","to":"grid-the-inverter","confidence":0.48},{"from":"grid","to":"follow-the-grid","confidence":0.48},{"from":"grid","to":"inverter-and-grid","confidence":0.48},{"from":"grid","to":"grid-are-synchronized","confidence":0.48},{"from":"grid","to":"plant-controller-provides","confidence":0.48},{"from":"grid","to":"provides-the-set","confidence":0.48},{"from":"voltage","to":"inverter","confidence":0.9},{"from":"voltage","to":"grid-voltage","confidence":0.48},{"from":"voltage","to":"inverter-operating-principles","confidence":0.48},{"from":"voltage","to":"current","confidence":0.73},{"from":"voltage","to":"power","confidence":0.65},{"from":"voltage","to":"foundational-inverter-operating","confidence":0.48},{"from":"voltage","to":"present-day-inverter","confidence":0.48},{"from":"voltage","to":"day-inverter-connects","confidence":0.48},{"from":"voltage","to":"grid-the-inverter","confidence":0.48},{"from":"voltage","to":"follow-the-grid","confidence":0.48},{"from":"voltage","to":"inverter-and-grid","confidence":0.48},{"from":"voltage","to":"grid-are-synchronized","confidence":0.48},{"from":"voltage","to":"plant-controller-provides","confidence":0.57},{"from":"voltage","to":"provides-the-set","confidence":0.48},{"from":"voltage","to":"measured-and-transformed","confidence":0.48},{"from":"voltage","to":"pwm-scheme","confidence":0.48},{"from":"voltage","to":"loop","confidence":0.57},{"from":"voltage","to":"output","confidence":0.57},{"from":"voltage","to":"current-and-measured","confidence":0.48},{"from":"voltage","to":"inputs-the-output","confidence":0.48},{"from":"voltage","to":"scheme-the-inverter","confidence":0.48},{"from":"voltage","to":"inverter-control-achieves","confidence":0.48},{"from":"voltage","to":"achieves-the-subjective","confidence":0.48},{"from":"voltage","to":"nested-loop-structure","confidence":0.48},{"from":"voltage","to":"structure-you-learned","confidence":0.48},{"from":"voltage","to":"2-but-let","confidence":0.48},{"from":"voltage","to":"provides-the-desired","confidence":0.48},{"from":"voltage","to":"active-and-reactive","confidence":0.65},{"from":"inverter","to":"measured-and-transformed","confidence":0.48},{"from":"inverter","to":"pwm-scheme","confidence":0.48},{"from":"inverter","to":"loop","confidence":0.57},{"from":"inverter","to":"output","confidence":0.57},{"from":"inverter","to":"current-and-measured","confidence":0.48},{"from":"inverter","to":"inputs-the-output","confidence":0.48},{"from":"inverter","to":"scheme-the-inverter","confidence":0.48},{"from":"inverter","to":"inverter-control-achieves","confidence":0.48},{"from":"inverter","to":"achieves-the-subjective","confidence":0.48},{"from":"inverter","to":"nested-loop-structure","confidence":0.48},{"from":"inverter","to":"structure-you-learned","confidence":0.48},{"from":"inverter","to":"2-but-let","confidence":0.48},{"from":"inverter","to":"provides-the-desired","confidence":0.48},{"from":"inverter","to":"active-and-reactive","confidence":0.65},{"from":"current","to":"measured-and-transformed","confidence":0.48},{"from":"current","to":"pwm-scheme","confidence":0.48},{"from":"current","to":"loop","confidence":0.57},{"from":"current","to":"output","confidence":0.57},{"from":"current","to":"current-and-measured","confidence":0.48},{"from":"current","to":"inputs-the-output","confidence":0.48},{"from":"current","to":"scheme-the-inverter","confidence":0.48},{"from":"current","to":"inverter-control-achieves","confidence":0.48},{"from":"current","to":"achieves-the-subjective","confidence":0.48},{"from":"current","to":"nested-loop-structure","confidence":0.48},{"from":"current","to":"structure-you-learned","confidence":0.48},{"from":"current","to":"2-but-let","confidence":0.48},{"from":"current","to":"provides-the-desired","confidence":0.48},{"from":"current","to":"active-and-reactive","confidence":0.57},{"from":"plant-controller-provides","to":"measured-and-transformed","confidence":0.48},{"from":"plant-controller-provides","to":"pwm-scheme","confidence":0.48},{"from":"plant-controller-provides","to":"loop","confidence":0.48},{"from":"plant-controller-provides","to":"output","confidence":0.48},{"from":"plant-controller-provides","to":"current-and-measured","confidence":0.48},{"from":"plant-controller-provides","to":"inputs-the-output","confidence":0.48},{"from":"plant-controller-provides","to":"scheme-the-inverter","confidence":0.48},{"from":"plant-controller-provides","to":"inverter-control-achieves","confidence":0.48},{"from":"plant-controller-provides","to":"achieves-the-subjective","confidence":0.48},{"from":"plant-controller-provides","to":"nested-loop-structure","confidence":0.48},{"from":"plant-controller-provides","to":"structure-you-learned","confidence":0.48},{"from":"plant-controller-provides","to":"2-but-let","confidence":0.48},{"from":"plant-controller-provides","to":"provides-the-desired","confidence":0.48},{"from":"plant-controller-provides","to":"active-and-reactive","confidence":0.48},{"from":"power","to":"current-control-let","confidence":0.48},{"from":"power","to":"voltage-control-power","confidence":0.48},{"from":"power","to":"primary-power-source","confidence":0.57},{"from":"power","to":"source-the-inverter","confidence":0.48},{"from":"power","to":"voltage-while-terminal","confidence":0.48},{"from":"power","to":"terminal-voltage-depends","confidence":0.48},{"from":"power","to":"inverter-and-how","confidence":0.48},{"from":"power","to":"how-the-system","confidence":0.48},{"from":"power","to":"active-and-reactive","confidence":0.57},{"from":"power","to":"discussed-current","confidence":0.48},{"from":"power","to":"reactive-power","confidence":0.57},{"from":"voltage","to":"current-control-let","confidence":0.48},{"from":"voltage","to":"voltage-control-power","confidence":0.48},{"from":"voltage","to":"primary-power-source","confidence":0.57},{"from":"voltage","to":"source-the-inverter","confidence":0.48},{"from":"voltage","to":"voltage-while-terminal","confidence":0.48},{"from":"voltage","to":"terminal-voltage-depends","confidence":0.48},{"from":"voltage","to":"inverter-and-how","confidence":0.48},{"from":"voltage","to":"how-the-system","confidence":0.48},{"from":"voltage","to":"discussed-current","confidence":0.48},{"from":"voltage","to":"reactive-power","confidence":0.57},{"from":"power-and-voltage","to":"power","confidence":0.48},{"from":"power-and-voltage","to":"inverter","confidence":0.48},{"from":"power-and-voltage","to":"current-control-let","confidence":0.48},{"from":"power-and-voltage","to":"voltage-control-power","confidence":0.48},{"from":"power-and-voltage","to":"primary-power-source","confidence":0.48},{"from":"power-and-voltage","to":"source-the-inverter","confidence":0.48},{"from":"power-and-voltage","to":"voltage-while-terminal","confidence":0.48},{"from":"power-and-voltage","to":"terminal-voltage-depends","confidence":0.48},{"from":"power-and-voltage","to":"inverter-and-how","confidence":0.48},{"from":"power-and-voltage","to":"how-the-system","confidence":0.48},{"from":"power-and-voltage","to":"active-and-reactive","confidence":0.48},{"from":"power-and-voltage","to":"discussed-current","confidence":0.48},{"from":"power-and-voltage","to":"reactive-power","confidence":0.48},{"from":"inverter","to":"current-control-let","confidence":0.48},{"from":"inverter","to":"voltage-control-power","confidence":0.48},{"from":"inverter","to":"primary-power-source","confidence":0.57},{"from":"inverter","to":"source-the-inverter","confidence":0.48},{"from":"inverter","to":"voltage-while-terminal","confidence":0.48},{"from":"inverter","to":"terminal-voltage-depends","confidence":0.48},{"from":"inverter","to":"inverter-and-how","confidence":0.48},{"from":"inverter","to":"how-the-system","confidence":0.48},{"from":"inverter","to":"discussed-current","confidence":0.48},{"from":"inverter","to":"reactive-power","confidence":0.57},{"from":"active-and-reactive","to":"current-control-let","confidence":0.48},{"from":"active-and-reactive","to":"voltage-control-power","confidence":0.48},{"from":"active-and-reactive","to":"primary-power-source","confidence":0.57},{"from":"active-and-reactive","to":"source-the-inverter","confidence":0.48},{"from":"active-and-reactive","to":"voltage-while-terminal","confidence":0.48},{"from":"active-and-reactive","to":"terminal-voltage-depends","confidence":0.48},{"from":"active-and-reactive","to":"inverter-and-how","confidence":0.48},{"from":"active-and-reactive","to":"how-the-system","confidence":0.48},{"from":"active-and-reactive","to":"discussed-current","confidence":0.48},{"from":"active-and-reactive","to":"reactive-power","confidence":0.57},{"from":"power","to":"active-power","confidence":0.48},{"from":"power","to":"loop","confidence":0.48},{"from":"power","to":"closed-loop","confidence":0.48},{"from":"power","to":"reactive-reference-current","confidence":0.48},{"from":"power","to":"output","confidence":0.48},{"from":"power","to":"approaches-for-managing","confidence":0.48},{"from":"reactive-power","to":"active-power","confidence":0.48},{"from":"reactive-power","to":"closed-loop","confidence":0.48},{"from":"reactive-power","to":"reactive-reference-current","confidence":0.48},{"from":"reactive-power","to":"approaches-for-managing","confidence":0.48},{"from":"voltage","to":"active-power","confidence":0.48},{"from":"voltage","to":"closed-loop","confidence":0.48},{"from":"voltage","to":"reactive-reference-current","confidence":0.48},{"from":"voltage","to":"approaches-for-managing","confidence":0.48},{"from":"loop","to":"reactive-power","confidence":0.48},{"from":"loop","to":"active-power","confidence":0.48},{"from":"loop","to":"closed-loop","confidence":0.48},{"from":"loop","to":"primary-power-source","confidence":0.48},{"from":"loop","to":"reactive-reference-current","confidence":0.48},{"from":"loop","to":"approaches-for-managing","confidence":0.48},{"from":"current","to":"reactive-power","confidence":0.48},{"from":"current","to":"active-power","confidence":0.48},{"from":"current","to":"closed-loop","confidence":0.48},{"from":"current","to":"primary-power-source","confidence":0.48},{"from":"current","to":"reactive-reference-current","confidence":0.48},{"from":"current","to":"approaches-for-managing","confidence":0.48},{"from":"active-and-reactive","to":"active-power","confidence":0.48},{"from":"active-and-reactive","to":"closed-loop","confidence":0.48},{"from":"active-and-reactive","to":"reactive-reference-current","confidence":0.48},{"from":"active-and-reactive","to":"approaches-for-managing","confidence":0.48},{"from":"primary-power-source","to":"active-power","confidence":0.48},{"from":"primary-power-source","to":"closed-loop","confidence":0.48},{"from":"primary-power-source","to":"reactive-reference-current","confidence":0.48},{"from":"primary-power-source","to":"approaches-for-managing","confidence":0.48},{"from":"inverter","to":"active-power","confidence":0.48},{"from":"inverter","to":"closed-loop","confidence":0.48},{"from":"inverter","to":"reactive-reference-current","confidence":0.48},{"from":"inverter","to":"approaches-for-managing","confidence":0.48},{"from":"output","to":"reactive-power","confidence":0.48},{"from":"output","to":"active-power","confidence":0.48},{"from":"output","to":"closed-loop","confidence":0.48},{"from":"output","to":"primary-power-source","confidence":0.48},{"from":"output","to":"reactive-reference-current","confidence":0.48},{"from":"output","to":"approaches-for-managing","confidence":0.48},{"from":"voltage","to":"terminal-voltage","confidence":0.48},{"from":"voltage","to":"reactive-current","confidence":0.48},{"from":"voltage","to":"short-circuit","confidence":0.48},{"from":"voltage","to":"short-circuit-ratio","confidence":0.48},{"from":"voltage","to":"response","confidence":0.57},{"from":"voltage","to":"system-voltage","confidence":0.48},{"from":"voltage","to":"active-current","confidence":0.48},{"from":"voltage","to":"grid-strength","confidence":0.48},{"from":"grid","to":"terminal-voltage","confidence":0.48},{"from":"grid","to":"reactive-current","confidence":0.48},{"from":"grid","to":"short-circuit","confidence":0.48},{"from":"grid","to":"short-circuit-ratio","confidence":0.48},{"from":"grid","to":"response","confidence":0.48},{"from":"grid","to":"system-voltage","confidence":0.48},{"from":"grid","to":"active-current","confidence":0.48},{"from":"grid","to":"grid-strength","confidence":0.48},{"from":"system","to":"current","confidence":0.48},{"from":"system","to":"terminal-voltage","confidence":0.48},{"from":"system","to":"reactive-current","confidence":0.48},{"from":"system","to":"short-circuit","confidence":0.48},{"from":"system","to":"short-circuit-ratio","confidence":0.48},{"from":"system","to":"response","confidence":0.48},{"from":"system","to":"system-voltage","confidence":0.48},{"from":"system","to":"active-current","confidence":0.48},{"from":"system","to":"grid-strength","confidence":0.48},{"from":"system","to":"inverter","confidence":0.48},{"from":"current","to":"terminal-voltage","confidence":0.48},{"from":"current","to":"reactive-current","confidence":0.48},{"from":"current","to":"short-circuit","confidence":0.48},{"from":"current","to":"short-circuit-ratio","confidence":0.48},{"from":"current","to":"response","confidence":0.48},{"from":"current","to":"system-voltage","confidence":0.48},{"from":"current","to":"active-current","confidence":0.48},{"from":"current","to":"grid-strength","confidence":0.48},{"from":"inverter","to":"terminal-voltage","confidence":0.48},{"from":"inverter","to":"reactive-current","confidence":0.48},{"from":"inverter","to":"short-circuit","confidence":0.48},{"from":"inverter","to":"short-circuit-ratio","confidence":0.48},{"from":"inverter","to":"response","confidence":0.57},{"from":"inverter","to":"system-voltage","confidence":0.48},{"from":"inverter","to":"active-current","confidence":0.48},{"from":"inverter","to":"grid-strength","confidence":0.48},{"from":"voltage","to":"normal-range","confidence":0.48},{"from":"voltage","to":"voltage-drive","confidence":0.48},{"from":"voltage","to":"fault-ride-through-response","confidence":0.48},{"from":"voltage","to":"ride-through-response-frt","confidence":0.48},{"from":"voltage","to":"normal-operating-conditions","confidence":0.48},{"from":"voltage","to":"conditions-where-voltage","confidence":0.48},{"from":"voltage","to":"voltage-and-frequency","confidence":0.48},{"from":"voltage","to":"plant-controller-generates","confidence":0.48},{"from":"voltage","to":"controller-generates-set","confidence":0.48},{"from":"voltage","to":"generates-set-points","confidence":0.48},{"from":"voltage","to":"points-for-individual","confidence":0.48},{"from":"voltage","to":"individual-inverters-what","confidence":0.48},{"from":"response","to":"normal-range","confidence":0.48},{"from":"response","to":"voltage-drive","confidence":0.48},{"from":"response","to":"fault-ride-through-response","confidence":0.48},{"from":"response","to":"ride-through-response-frt","confidence":0.48},{"from":"response","to":"normal-operating-conditions","confidence":0.48},{"from":"response","to":"conditions-where-voltage","confidence":0.48},{"from":"response","to":"voltage-and-frequency","confidence":0.48},{"from":"response","to":"plant-controller-generates","confidence":0.48},{"from":"response","to":"controller-generates-set","confidence":0.48},{"from":"response","to":"generates-set-points","confidence":0.48},{"from":"response","to":"points-for-individual","confidence":0.48},{"from":"response","to":"individual-inverters-what","confidence":0.48},{"from":"inverter","to":"normal-range","confidence":0.48},{"from":"inverter","to":"voltage-drive","confidence":0.48},{"from":"inverter","to":"fault-ride-through-response","confidence":0.48},{"from":"inverter","to":"ride-through-response-frt","confidence":0.48},{"from":"inverter","to":"normal-operating-conditions","confidence":0.48},{"from":"inverter","to":"conditions-where-voltage","confidence":0.48},{"from":"inverter","to":"voltage-and-frequency","confidence":0.48},{"from":"inverter","to":"plant-controller-generates","confidence":0.48},{"from":"inverter","to":"controller-generates-set","confidence":0.48},{"from":"inverter","to":"generates-set-points","confidence":0.48},{"from":"inverter","to":"points-for-individual","confidence":0.48},{"from":"inverter","to":"individual-inverters-what","confidence":0.48},{"from":"inverter-operating-principles","to":"inverter-based-resource-basics","confidence":0.48},{"from":"inverter-operating-principles","to":"basics-and-operations","confidence":0.48},{"from":"inverter-operating-principles","to":"reviewed-some-basic","confidence":0.48},{"from":"inverter-operating-principles","to":"basic-inverter-operating","confidence":0.48},{"from":"inverter-operating-principles","to":"conditions-for-current","confidence":0.48},{"from":"inverter-operating-principles","to":"current-outer-loop","confidence":0.48},{"from":"inverter-operating-principles","to":"outer-loop-reactive","confidence":0.48},{"from":"inverter-operating-principles","to":"loop-reactive-power","confidence":0.48},{"from":"inverter-operating-principles","to":"fault-ride-through-response","confidence":0.48},{"from":"inverter-operating-principles","to":"ibr-control-system","confidence":0.48},{"from":"inverter-operating-principles","to":"system-options-covered","confidence":0.48},{"from":"inverter-operating-principles","to":"normal-conditions","confidence":0.48},{"from":"inverter-operating-principles","to":"various-ibr","confidence":0.48},{"from":"power-and-voltage","to":"inverter-based-resource-basics","confidence":0.48},{"from":"power-and-voltage","to":"basics-and-operations","confidence":0.48},{"from":"power-and-voltage","to":"reviewed-some-basic","confidence":0.48},{"from":"power-and-voltage","to":"basic-inverter-operating","confidence":0.48},{"from":"power-and-voltage","to":"inverter-operating-principles","confidence":0.48},{"from":"power-and-voltage","to":"conditions-for-current","confidence":0.48},{"from":"power-and-voltage","to":"current-outer-loop","confidence":0.48},{"from":"power-and-voltage","to":"outer-loop-reactive","confidence":0.48},{"from":"power-and-voltage","to":"loop-reactive-power","confidence":0.48},{"from":"power-and-voltage","to":"fault-ride-through-response","confidence":0.48},{"from":"power-and-voltage","to":"ibr-control-system","confidence":0.48},{"from":"power-and-voltage","to":"system-options-covered","confidence":0.48},{"from":"power-and-voltage","to":"normal-conditions","confidence":0.48},{"from":"power-and-voltage","to":"various-ibr","confidence":0.48},{"from":"fault-ride-through-response","to":"inverter-based-resource-basics","confidence":0.48},{"from":"fault-ride-through-response","to":"basics-and-operations","confidence":0.48},{"from":"fault-ride-through-response","to":"reviewed-some-basic","confidence":0.48},{"from":"fault-ride-through-response","to":"basic-inverter-operating","confidence":0.48},{"from":"fault-ride-through-response","to":"conditions-for-current","confidence":0.48},{"from":"fault-ride-through-response","to":"current-outer-loop","confidence":0.48},{"from":"fault-ride-through-response","to":"outer-loop-reactive","confidence":0.48},{"from":"fault-ride-through-response","to":"loop-reactive-power","confidence":0.48},{"from":"fault-ride-through-response","to":"ibr-control-system","confidence":0.48},{"from":"fault-ride-through-response","to":"system-options-covered","confidence":0.48},{"from":"fault-ride-through-response","to":"normal-conditions","confidence":0.48},{"from":"fault-ride-through-response","to":"various-ibr","confidence":0.48}]}`;
const COURSE = JSON.parse(RAW_DATA);

// ════════════════════════════════════════════════════════════════
// GRAPH UTILITIES
// ════════════════════════════════════════════════════════════════

const conceptById = (id) => COURSE.concepts.find(c => c.id === id);
const slideById = (id) => COURSE.slides.find(s => s.id === id);
const sceneById = (id) => COURSE.scenes.find(s => s.id === id);

// For a slide, find concepts taught here AND their prerequisites
const conceptsForSlide = (slideId) => {
  return COURSE.concepts.filter(c => c.taught_in_slides.includes(slideId));
};

// Find concepts that are prerequisites of the ones in this slide
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

// Find which slide first introduces each concept (lowest slide index where it appears)
const firstSlideForConcept = (() => {
  const cache = {};
  return (conceptId) => {
    if (conceptId in cache) return cache[conceptId];
    const concept = conceptById(conceptId);
    if (!concept || concept.taught_in_slides.length === 0) return cache[conceptId] = null;
    // Slides have stable order in COURSE.slides
    const slideIndex = (sid) => COURSE.slides.findIndex(s => s.id === sid);
    const sorted = [...concept.taught_in_slides].sort((a, b) => slideIndex(a) - slideIndex(b));
    return cache[conceptId] = sorted[0];
  };
})();

// ════════════════════════════════════════════════════════════════
// CONCEPT-AWARE TRANSCRIPT RENDERER
// Highlights concept phrases inline in the transcript text
// ════════════════════════════════════════════════════════════════

function HighlightedTranscript({ text, conceptIds, onConceptClick }) {
  // Sort concepts by phrase length descending so we match longer phrases first
  const concepts = conceptIds
    .map(id => conceptById(id))
    .filter(Boolean)
    .sort((a, b) => b.label.length - a.label.length);

  // Build a list of {start, end, conceptId} ranges, no overlaps
  const ranges = [];
  const lower = text.toLowerCase();
  concepts.forEach(c => {
    const phrase = c.label.toLowerCase();
    let i = 0;
    while ((i = lower.indexOf(phrase, i)) !== -1) {
      const end = i + phrase.length;
      // Skip if overlaps an existing range
      const overlaps = ranges.some(r => !(end <= r.start || i >= r.end));
      if (!overlaps) {
        // Word-boundary check
        const before = i === 0 ? ' ' : text[i - 1];
        const after = end >= text.length ? ' ' : text[end];
        if (/[\w]/.test(before) || /[\w]/.test(after)) {
          // Not a word-boundary match
        } else {
          ranges.push({ start: i, end, conceptId: c.id });
        }
      }
      i = end;
    }
  });
  ranges.sort((a, b) => a.start - b.start);

  // Render
  const parts = [];
  let cursor = 0;
  ranges.forEach((r, idx) => {
    if (cursor < r.start) parts.push({ kind: 'text', text: text.slice(cursor, r.start), key: `t${idx}` });
    parts.push({ kind: 'concept', text: text.slice(r.start, r.end), conceptId: r.conceptId, key: `c${idx}` });
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
              background: 'rgba(193, 80, 28, 0.08)',
              border: 'none',
              borderBottom: '1.5px solid #c1501c',
              padding: '0 1px',
              margin: 0,
              font: 'inherit',
              color: '#1a2332',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
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
// CONCEPT NETWORK (force-directed-ish 2D positioned graph)
// ════════════════════════════════════════════════════════════════

function ConceptNetwork({ selectedSlide, onConceptClick, hoveredConcept, setHoveredConcept }) {
  const svgRef = useRef(null);
  const width = 480;
  const height = 380;

  // Pick the top N concepts by confidence × frequency
  const focusConcepts = useMemo(() => {
    const slideConceptIds = selectedSlide
      ? new Set(slideById(selectedSlide)?.concept_ids || [])
      : null;
    const ranked = [...COURSE.concepts]
      .filter(c => c.tier <= 2 || (slideConceptIds && slideConceptIds.has(c.id)))
      .sort((a, b) => (b.confidence * Math.log(b.total_freq + 1)) - (a.confidence * Math.log(a.total_freq + 1)))
      .slice(0, 24);
    return ranked;
  }, [selectedSlide]);

  // Position concepts in a soft circular cluster, with deterministic seed from id
  const positions = useMemo(() => {
    const pos = {};
    const cx = width / 2, cy = height / 2;
    focusConcepts.forEach((c, i) => {
      // Hash the id to a stable angle/radius
      let h = 0;
      for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const angle = (h % 1000) / 1000 * Math.PI * 2;
      const ringIdx = i < 6 ? 0 : i < 14 ? 1 : 2;
      const radius = [40, 110, 165][ringIdx] + ((h >> 10) % 20);
      pos[c.id] = {
        x: cx + Math.cos(angle + ringIdx * 0.4 + i * 0.2) * radius,
        y: cy + Math.sin(angle + ringIdx * 0.4 + i * 0.2) * radius,
      };
    });
    return pos;
  }, [focusConcepts]);

  // Edges: prereq edges where both endpoints are visible
  const visibleEdges = useMemo(() => {
    const visible = new Set(focusConcepts.map(c => c.id));
    return COURSE.prereq_edges.filter(e => visible.has(e.from) && visible.has(e.to));
  }, [focusConcepts]);

  const slideConceptSet = useMemo(() =>
    selectedSlide ? new Set(slideById(selectedSlide)?.concept_ids || []) : new Set(),
    [selectedSlide]
  );

  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <polygon points="0 0, 6 3, 0 6" fill="#1a2332" opacity="0.5" />
        </marker>
        <pattern id="netgrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#cdc4b0" strokeWidth="0.3" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#netgrid)" />

      {/* Edges */}
      {visibleEdges.map((e, i) => {
        const a = positions[e.from], b = positions[e.to];
        if (!a || !b) return null;
        const isHi = hoveredConcept === e.from || hoveredConcept === e.to;
        return (
          <line
            key={i}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={isHi ? '#c1501c' : '#1a2332'}
            strokeWidth={isHi ? 1.5 : 0.6}
            opacity={isHi ? 0.9 : 0.25}
            markerEnd="url(#arrowhead)"
          />
        );
      })}

      {/* Nodes */}
      {focusConcepts.map(c => {
        const p = positions[c.id];
        if (!p) return null;
        const isInSlide = slideConceptSet.has(c.id);
        const isHovered = hoveredConcept === c.id;
        const r = 4 + Math.min(8, c.total_freq);
        return (
          <g key={c.id}
             transform={`translate(${p.x}, ${p.y})`}
             style={{ cursor: 'pointer' }}
             onMouseEnter={() => setHoveredConcept(c.id)}
             onMouseLeave={() => setHoveredConcept(null)}
             onClick={() => onConceptClick(c.id)}
          >
            <circle
              r={r}
              fill={isInSlide ? '#c1501c' : '#f5efe2'}
              stroke="#1a2332"
              strokeWidth={isHovered ? 2 : 1}
            />
            {(isHovered || isInSlide) && (
              <text
                y={r + 11}
                textAnchor="middle"
                fontSize="9.5"
                fontFamily="JetBrains Mono, monospace"
                fill="#1a2332"
                style={{ pointerEvents: 'none' }}
              >
                {c.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ════════════════════════════════════════════════════════════════
// CHAT WITH THE COURSE
// Uses the Claude API with course graph data as grounded context
// ════════════════════════════════════════════════════════════════

function buildCourseContext(question) {
  // Pick the most relevant slides + concepts to inject as context.
  // Cheap relevance: lowercased term overlap between question and slide.
  const q = question.toLowerCase();
  const qTokens = new Set(q.split(/\W+/).filter(t => t.length > 3));

  const scoredSlides = COURSE.slides.map(s => {
    const haystack = (s.title + ' ' + s.transcript_combined + ' ' + (s.alt_text_corpus || '')).toLowerCase();
    let score = 0;
    qTokens.forEach(t => {
      if (haystack.includes(t)) score += 1;
    });
    return { s, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  // Take top 4 relevant slides; if none, take first 4 narrated slides
  let chosen = scoredSlides.slice(0, 4).map(x => x.s);
  if (chosen.length === 0) {
    chosen = COURSE.slides.filter(s => s.transcript_combined.length > 50).slice(0, 4);
  }

  const slideBlocks = chosen.map(s => {
    const concepts = s.concept_ids
      .map(conceptById)
      .filter(Boolean)
      .map(c => c.label)
      .slice(0, 6)
      .join(', ');
    return [
      `[Slide #${s.sequence_index + 1}: ${s.title}] (id: ${s.id})`,
      concepts ? `  Concepts taught: ${concepts}` : '',
      s.transcript_combined ? `  Transcript: ${s.transcript_combined}` : '',
      s.alt_text_corpus ? `  On-screen labels: ${s.alt_text_corpus.substring(0, 200)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const allConceptList = COURSE.concepts
    .filter(c => c.tier <= 2)
    .slice(0, 30)
    .map(c => c.label)
    .join(', ');

  return { slideBlocks, allConceptList, citedSlides: chosen };
}

async function askClaude(question, history) {
  const { slideBlocks, allConceptList, citedSlides } = buildCourseContext(question);

  const systemPrompt = `You are a tutor for a power-systems course titled "${COURSE.package.title}". Your knowledge is strictly limited to the course content provided below. Answer the user's questions using only this material. When you reference specific content, cite the slide by its title in square brackets, e.g. [Active and Reactive Power Control]. If the course material does not address the question, say so honestly rather than inventing.

Course structure: ${COURSE.scenes.length} scenes, ${COURSE.slides.length} slides, ${COURSE.stats.audio_seconds.toFixed(0)} seconds of narration.

Top concepts in the course: ${allConceptList}.

Most relevant slide content for this question:
─────────────────────────────────────────
${slideBlocks}
─────────────────────────────────────────

Keep responses concise — 2-4 short paragraphs unless the user asks for depth. Use plain prose, not bullet lists, unless the question is clearly enumerative.`;

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
  return { text, citedSlides };
}

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
      const { text, citedSlides } = await askClaude(q, messages);
      setMessages([...newMessages, { role: 'assistant', content: text, citedSlides }]);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  const exemplarQs = [
    "What's the difference between active and reactive power control?",
    "How does fault ride-through work?",
    "Why does the inverter need to follow the grid voltage?",
  ];

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#f5efe2',
      borderLeft: '1px solid #1a2332',
    }}>
      <div style={{
        padding: '14px 18px 12px',
        borderBottom: '1px solid #1a2332',
        background: '#1a2332',
        color: '#f5efe2',
      }}>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 9,
          letterSpacing: '0.18em',
          opacity: 0.7,
          marginBottom: 4,
        }}>
          ─── INTERLOCUTOR ───
        </div>
        <div style={{ fontFamily: 'EB Garamond, Georgia, serif', fontSize: 22, fontStyle: 'italic' }}>
          Chat with the course
        </div>
      </div>

      <div ref={scrollerRef} style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 18px',
      }}>
        {messages.length === 0 && (
          <div style={{ color: '#1a2332', opacity: 0.7 }}>
            <div style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              fontSize: 15,
              marginBottom: 18,
              lineHeight: 1.55,
            }}>
              Ask anything about the course material. Answers are grounded in the
              transcribed narration and recovered slide structure — citations point
              back to specific slides.
            </div>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              letterSpacing: '0.15em',
              color: '#1a2332',
              opacity: 0.6,
              marginBottom: 8,
            }}>
              ── TRY ──
            </div>
            {exemplarQs.map((q, i) => (
              <button
                key={i}
                onClick={() => setInput(q)}
                style={{
                  display: 'block',
                  textAlign: 'left',
                  width: '100%',
                  padding: '8px 10px',
                  marginBottom: 6,
                  background: 'transparent',
                  border: '1px solid #1a2332',
                  borderRadius: 0,
                  fontFamily: 'EB Garamond, serif',
                  fontSize: 14,
                  fontStyle: 'italic',
                  color: '#1a2332',
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#1a2332'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onMouseDown={e => e.currentTarget.style.color = '#f5efe2'}
                onMouseUp={e => e.currentTarget.style.color = '#1a2332'}
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 18 }}>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              letterSpacing: '0.18em',
              color: m.role === 'user' ? '#c1501c' : '#1a2332',
              opacity: 0.7,
              marginBottom: 4,
            }}>
              {m.role === 'user' ? '── YOU ──' : '── COURSE ──'}
            </div>
            <div style={{
              fontFamily: m.role === 'user' ? 'JetBrains Mono, monospace' : 'EB Garamond, Georgia, serif',
              fontSize: m.role === 'user' ? 13 : 16,
              lineHeight: m.role === 'user' ? 1.5 : 1.55,
              color: '#1a2332',
              whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
            {m.citedSlides && m.citedSlides.length > 0 && (
              <div style={{
                marginTop: 8,
                paddingTop: 8,
                borderTop: '0.5px dashed #1a2332',
              }}>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 8.5,
                  letterSpacing: '0.18em',
                  opacity: 0.6,
                  marginBottom: 6,
                }}>
                  CITED
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {m.citedSlides.map(s => (
                    <button
                      key={s.id}
                      onClick={() => onSlideClick(s.id)}
                      style={{
                        padding: '3px 8px',
                        background: 'transparent',
                        border: '1px solid #1a2332',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 10,
                        color: '#1a2332',
                        cursor: 'pointer',
                      }}
                    >
                      §{s.sequence_index + 1} {s.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              letterSpacing: '0.18em',
              opacity: 0.5,
              marginBottom: 4,
            }}>
              ── COURSE ──
            </div>
            <div style={{
              fontFamily: 'EB Garamond, serif',
              fontSize: 15,
              fontStyle: 'italic',
              color: '#1a2332',
              opacity: 0.7,
            }}>
              Consulting the graph
              <span className="dot-blink">.</span>
              <span className="dot-blink" style={{ animationDelay: '0.2s' }}>.</span>
              <span className="dot-blink" style={{ animationDelay: '0.4s' }}>.</span>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: 10,
            border: '1px solid #c1501c',
            color: '#c1501c',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            marginBottom: 12,
          }}>
            {error}
          </div>
        )}
      </div>

      <div style={{
        borderTop: '1px solid #1a2332',
        padding: 10,
        display: 'flex',
        gap: 8,
      }}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder="Ask about the course…"
          disabled={loading}
          style={{
            flex: 1,
            padding: '8px 10px',
            background: '#fdf9ee',
            border: '1px solid #1a2332',
            fontFamily: 'EB Garamond, Georgia, serif',
            fontSize: 14,
            fontStyle: 'italic',
            color: '#1a2332',
            outline: 'none',
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{
            padding: '8px 14px',
            background: '#1a2332',
            color: '#f5efe2',
            border: '1px solid #1a2332',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            letterSpacing: '0.1em',
            cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
            opacity: loading || !input.trim() ? 0.5 : 1,
          }}
        >
          ASK ↵
        </button>
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

  const slide = slideById(selectedSlide);
  const slideConcepts = slide ? conceptsForSlide(slide.id) : [];
  const slidePrereqs = slide ? prereqsOfSlide(slide.id) : [];
  const concept = selectedConcept ? conceptById(selectedConcept) : null;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=JetBrains+Mono:wght@400;500;600&display=swap');

        * { box-sizing: border-box; }

        body {
          margin: 0;
          background: #ddd4be;
          color: #1a2332;
        }

        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #ddd4be; }
        ::-webkit-scrollbar-thumb { background: #1a2332; border-radius: 0; }

        .dashboard-root {
          min-height: 100vh;
          background:
            repeating-linear-gradient(
              0deg,
              transparent 0,
              transparent 39px,
              rgba(26, 35, 50, 0.04) 39px,
              rgba(26, 35, 50, 0.04) 40px
            ),
            #f5efe2;
          color: #1a2332;
          font-family: 'EB Garamond', Georgia, serif;
        }

        .dot-blink {
          animation: dot-blink 1.4s infinite;
          opacity: 0;
        }

        @keyframes dot-blink {
          0%, 80%, 100% { opacity: 0; }
          40% { opacity: 1; }
        }

        .slide-button {
          width: 100%;
          text-align: left;
          padding: 6px 10px;
          background: transparent;
          border: none;
          border-left: 2px solid transparent;
          font-family: 'EB Garamond', Georgia, serif;
          font-size: 14px;
          color: #1a2332;
          cursor: pointer;
          transition: all 0.15s;
          line-height: 1.3;
          display: flex;
          gap: 8px;
        }
        .slide-button:hover { background: rgba(26, 35, 50, 0.06); }
        .slide-button.active {
          border-left-color: #c1501c;
          background: rgba(193, 80, 28, 0.08);
        }
        .slide-button .num {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          opacity: 0.5;
          padding-top: 2px;
          min-width: 24px;
        }
      `}</style>

      <div className="dashboard-root">
        <div style={{
          maxWidth: 1480,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: '260px 1fr 460px',
          gap: 0,
          minHeight: '100vh',
          borderLeft: '1px solid #1a2332',
          borderRight: '1px solid #1a2332',
        }}>

          {/* ════════ LEFT: NAVIGATOR ════════ */}
          <aside style={{
            borderRight: '1px solid #1a2332',
            background: '#f5efe2',
            padding: '20px 14px 32px',
            position: 'sticky',
            top: 0,
            alignSelf: 'flex-start',
            height: '100vh',
            overflowY: 'auto',
          }}>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              letterSpacing: '0.2em',
              opacity: 0.6,
              marginBottom: 6,
            }}>
              FOXXI ⟢ CONTEXT&nbsp;GRAPH
            </div>
            <div style={{
              fontFamily: 'EB Garamond, Georgia, serif',
              fontStyle: 'italic',
              fontSize: 24,
              lineHeight: 1.05,
              marginBottom: 4,
              color: '#1a2332',
            }}>
              Lesson 3
            </div>
            <div style={{
              fontFamily: 'EB Garamond, Georgia, serif',
              fontSize: 15,
              marginBottom: 22,
              opacity: 0.85,
            }}>
              Inverter Controls
            </div>

            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 8.5,
              letterSpacing: '0.18em',
              opacity: 0.55,
              padding: '4px 0',
              borderTop: '0.5px solid #1a2332',
              borderBottom: '0.5px solid #1a2332',
              marginBottom: 16,
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 4,
            }}>
              <div>SCENES <span style={{ color: '#c1501c' }}>{COURSE.scenes.length}</span></div>
              <div>SLIDES <span style={{ color: '#c1501c' }}>{COURSE.slides.length}</span></div>
              <div>CONCEPTS <span style={{ color: '#c1501c' }}>{COURSE.concepts.length}</span></div>
              <div>EDGES <span style={{ color: '#c1501c' }}>{COURSE.prereq_edges.length}</span></div>
            </div>

            {COURSE.scenes.map(scene => (
              <div key={scene.id} style={{ marginBottom: 18 }}>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  opacity: 0.6,
                  marginBottom: 6,
                }}>
                  ── SCENE {scene.scene_number} ──
                </div>
                {scene.slide_ids.map(sid => {
                  const s = slideById(sid);
                  if (!s) return null;
                  return (
                    <button
                      key={sid}
                      className={`slide-button ${selectedSlide === sid ? 'active' : ''}`}
                      onClick={() => { setSelectedSlide(sid); setSelectedConcept(null); }}
                    >
                      <span className="num">§{s.sequence_index + 1}</span>
                      <span>{s.title}</span>
                    </button>
                  );
                })}
              </div>
            ))}

            <div style={{
              marginTop: 24,
              paddingTop: 12,
              borderTop: '0.5px solid #1a2332',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              opacity: 0.55,
              lineHeight: 1.6,
            }}>
              <div>parser/v{COURSE.package.parser_version}</div>
              <div>{COURSE.package.standard}</div>
              <div>{COURSE.package.authoring_tool}</div>
            </div>
          </aside>

          {/* ════════ CENTER: SLIDE DETAIL ════════ */}
          <main style={{ padding: '28px 36px 60px', minWidth: 0 }}>

            {/* Concept network panel */}
            <div style={{
              border: '1px solid #1a2332',
              background: '#fdf9ee',
              padding: '14px 18px',
              marginBottom: 24,
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 8,
              }}>
                <div>
                  <div style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 9,
                    letterSpacing: '0.2em',
                    opacity: 0.6,
                  }}>
                    FIG. 01 — CONCEPT&nbsp;TOPOLOGY
                  </div>
                  <div style={{
                    fontFamily: 'EB Garamond, serif',
                    fontStyle: 'italic',
                    fontSize: 17,
                    marginTop: 2,
                  }}>
                    Top concepts and their inferred dependencies
                  </div>
                </div>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  opacity: 0.7,
                }}>
                  {selectedSlide && slide && (
                    <>
                      <span style={{ color: '#c1501c' }}>●</span> in {slide.title.length > 22 ? slide.title.slice(0, 22) + '…' : slide.title}
                    </>
                  )}
                </div>
              </div>
              <ConceptNetwork
                selectedSlide={selectedSlide}
                onConceptClick={setSelectedConcept}
                hoveredConcept={hoveredConcept}
                setHoveredConcept={setHoveredConcept}
              />
              {hoveredConcept && (
                <div style={{
                  marginTop: 4,
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  color: '#1a2332',
                }}>
                  ▸ <span style={{ color: '#c1501c' }}>{conceptById(hoveredConcept)?.label}</span>
                  <span style={{ opacity: 0.6 }}>
                    {' '}— confidence {conceptById(hoveredConcept)?.confidence.toFixed(2)},
                    in {conceptById(hoveredConcept)?.taught_in_slides.length} slide(s)
                  </span>
                </div>
              )}
            </div>

            {/* Slide detail */}
            {slide && (
              <article>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  borderBottom: '1px solid #1a2332',
                  paddingBottom: 8,
                  marginBottom: 18,
                }}>
                  <div>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 10,
                      letterSpacing: '0.2em',
                      opacity: 0.6,
                    }}>
                      § {slide.sequence_index + 1}
                      <span style={{ margin: '0 8px' }}>·</span>
                      SLIDE&nbsp;{slide.lms_id || slide.id.slice(0, 8)}
                    </div>
                    <h1 style={{
                      fontFamily: 'EB Garamond, Georgia, serif',
                      fontSize: 38,
                      fontWeight: 500,
                      margin: '4px 0 0',
                      lineHeight: 1.05,
                      letterSpacing: '-0.01em',
                    }}>
                      {slide.title}
                    </h1>
                  </div>
                  <div style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    textAlign: 'right',
                    opacity: 0.7,
                    lineHeight: 1.6,
                  }}>
                    {slide.audio_count > 0 && (
                      <div>
                        ♪ {slide.audio_count} narration{slide.audio_count > 1 ? 's' : ''}
                      </div>
                    )}
                    {slide.transcript_segments.length > 0 && (
                      <div>
                        {slide.transcript_segments.reduce((a, t) => a + t.duration, 0).toFixed(0)}s audio
                      </div>
                    )}
                    <div>{slideConcepts.length} concept(s)</div>
                  </div>
                </div>

                {/* Transcript */}
                <section style={{ marginBottom: 32 }}>
                  <div style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 9,
                    letterSpacing: '0.2em',
                    opacity: 0.55,
                    marginBottom: 6,
                  }}>
                    ── NARRATION TRANSCRIPT ──
                  </div>
                  {slide.transcript_combined ? (
                    <div style={{
                      fontFamily: 'EB Garamond, Georgia, serif',
                      fontSize: 18,
                      lineHeight: 1.65,
                      maxWidth: '64ch',
                      color: '#1a2332',
                    }}>
                      <span style={{
                        fontFamily: 'EB Garamond, serif',
                        fontSize: 50,
                        float: 'left',
                        lineHeight: 0.9,
                        margin: '6px 8px -2px 0',
                        color: '#c1501c',
                        fontWeight: 500,
                      }}>
                        {slide.transcript_combined.charAt(0)}
                      </span>
                      <HighlightedTranscript
                        text={slide.transcript_combined.slice(1)}
                        conceptIds={slide.concept_ids}
                        onConceptClick={setSelectedConcept}
                      />
                    </div>
                  ) : (
                    <div style={{
                      fontFamily: 'EB Garamond, serif',
                      fontStyle: 'italic',
                      fontSize: 15,
                      opacity: 0.55,
                    }}>
                      No narration captured for this slide.
                      {slide.alt_text_corpus && <> On-screen labels recovered: <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{slide.alt_text_corpus.slice(0, 200)}</span></>}
                    </div>
                  )}
                </section>

                {/* Concepts on this slide */}
                {slideConcepts.length > 0 && (
                  <section style={{ marginBottom: 32 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      letterSpacing: '0.2em',
                      opacity: 0.55,
                      marginBottom: 8,
                    }}>
                      ── CONCEPTS TAUGHT ({slideConcepts.length}) ──
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {slideConcepts.map(c => (
                        <button
                          key={c.id}
                          onClick={() => setSelectedConcept(c.id)}
                          style={{
                            padding: '6px 10px 6px 12px',
                            background: selectedConcept === c.id ? '#c1501c' : 'transparent',
                            color: selectedConcept === c.id ? '#fdf9ee' : '#1a2332',
                            border: '1px solid #1a2332',
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 11,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {c.label}
                          <span style={{
                            fontSize: 9,
                            opacity: 0.6,
                          }}>{c.confidence.toFixed(2)}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {/* Prerequisites */}
                {slidePrereqs.length > 0 && (
                  <section style={{ marginBottom: 32 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      letterSpacing: '0.2em',
                      opacity: 0.55,
                      marginBottom: 8,
                    }}>
                      ── PREREQUISITES (inferred) ──
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {slidePrereqs.slice(0, 12).map((e, i) => {
                        const c = conceptById(e.from);
                        if (!c) return null;
                        const firstSlide = firstSlideForConcept(c.id);
                        return (
                          <button
                            key={i}
                            onClick={() => firstSlide && setSelectedSlide(firstSlide)}
                            style={{
                              padding: '4px 8px',
                              background: '#fdf9ee',
                              border: '0.5px solid #1a2332',
                              fontFamily: 'EB Garamond, serif',
                              fontStyle: 'italic',
                              fontSize: 13,
                              color: '#1a2332',
                              cursor: 'pointer',
                            }}
                          >
                            ↰ {c.label}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Audio assets */}
                {slide.transcript_segments.length > 0 && (
                  <section style={{ marginBottom: 24 }}>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      letterSpacing: '0.2em',
                      opacity: 0.55,
                      marginBottom: 8,
                    }}>
                      ── AUDIO ASSETS ──
                    </div>
                    {slide.transcript_segments.map((t, i) => (
                      <div key={i} style={{
                        marginBottom: 8,
                        padding: '8px 10px',
                        background: '#fdf9ee',
                        border: '0.5px solid #1a2332',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11,
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}>
                        <span style={{
                          opacity: 0.6,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
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

            {/* Concept detail panel (when one selected) */}
            {concept && (
              <div style={{
                marginTop: 32,
                padding: '16px 20px',
                background: '#1a2332',
                color: '#f5efe2',
                position: 'relative',
              }}>
                <button
                  onClick={() => setSelectedConcept(null)}
                  style={{
                    position: 'absolute',
                    top: 10,
                    right: 12,
                    background: 'transparent',
                    border: '1px solid #f5efe2',
                    color: '#f5efe2',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    padding: '2px 8px',
                    cursor: 'pointer',
                  }}
                >
                  ✕
                </button>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 9,
                  letterSpacing: '0.2em',
                  opacity: 0.6,
                  marginBottom: 4,
                }}>
                  ── CONCEPT ──
                </div>
                <div style={{
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 26,
                  marginBottom: 10,
                }}>
                  {concept.label}
                </div>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  opacity: 0.8,
                  marginBottom: 14,
                  lineHeight: 1.7,
                }}>
                  confidence&nbsp;<span style={{ color: '#e89071' }}>{concept.confidence.toFixed(2)}</span>
                  &nbsp;·&nbsp;tier&nbsp;<span style={{ color: '#e89071' }}>{concept.tier}</span>
                  &nbsp;·&nbsp;in&nbsp;<span style={{ color: '#e89071' }}>{concept.taught_in_slides.length}</span>&nbsp;slide(s)
                  &nbsp;·&nbsp;{concept.total_freq}× mentioned
                </div>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 9,
                  letterSpacing: '0.2em',
                  opacity: 0.6,
                  marginBottom: 6,
                }}>
                  TAUGHT IN
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {concept.taught_in_slides.map(sid => {
                    const s = slideById(sid);
                    if (!s) return null;
                    return (
                      <button
                        key={sid}
                        onClick={() => { setSelectedSlide(sid); setSelectedConcept(null); }}
                        style={{
                          padding: '4px 9px',
                          background: 'transparent',
                          border: '1px solid #f5efe2',
                          color: '#f5efe2',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 10,
                          cursor: 'pointer',
                        }}
                      >
                        §{s.sequence_index + 1} · {s.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </main>

          {/* ════════ RIGHT: CHAT ════════ */}
          <aside style={{
            position: 'sticky',
            top: 0,
            height: '100vh',
          }}>
            <ChatPanel onSlideClick={setSelectedSlide} />
          </aside>
        </div>
      </div>
    </>
  );
}
