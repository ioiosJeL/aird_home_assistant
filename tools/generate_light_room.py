#!/usr/bin/env python3
"""
Scaffold a new packages/lights/<room>.yaml file.

This does NOT touch Home Assistant's live config or reload anything - it
just writes one YAML file to packages/lights/, following the exact pattern
already used by every existing room (bathroom.yaml, dining_room.yaml, etc.):
the 8 boilerplate helper entities (input_text x2, input_number x1,
input_boolean x3, timer x2), the input_select of scenes, the light group,
and the standard use_blueprint automations from blueprints/automation/lights/.

What it can't guess for you (fill in after generating):
  - the actual light entities in the room's light group
  - the physical switch/dimmer trigger (shelly device id + channel) for the
    toggle/scroll automations, if the room has a physical switch
  - any bespoke extras (secret buttons, TV integration, etc.) - copy those
    from a similar existing room file by hand

You still need to (separately, in packages/motion.yaml):
  - add binary_sensor.<slug>_motion to the `template: binary_sensor:` list
  - add input_number.<slug>_motion_timeout

And create the room's scene scripts (script.<slug>_scene_bright etc.) -
see packages/lights/<some_room>_scenes.yaml for the pattern.

Usage:
  python3 generate_light_room.py --slug garden_room --name "Garden Room" \\
      --scenes Bright,Relax,Cosy,Off \\
      --lights light.garden_room_ceiling,light.garden_room_lamp \\
      --shelly-device shellydimmer2-AABBCC --shelly-channel 1

Run with --help for all options. Prints to stdout by default; pass
--write to save directly to packages/lights/<slug>.yaml.
"""
import argparse
import os
import sys

TEMPLATE = """homeassistant:
  customize_glob:
    package.node_anchors:
      double: &double
        package: "Lights"
        room: "{display_name}"
    input_number.{slug}_*:
      <<: *double
    light.{slug}_*:
      <<: *double
    timer.{slug}_*:
      <<: *double

  customize:
    input_select.{slug}_scenes:
      <<: *double
    input_text.{slug}_last_action:
      <<: *double
    input_text.{slug}_previous_scene:
      <<: *double
    input_boolean.{slug}_scene_changing:
      <<: *double

input_select:
  # All scenes
  {slug}_scenes:
    name: {display_name} Scenes
    options:
{scene_options}
    icon: mdi:palette-outline

input_text:
  # The last action performed
  {slug}_last_action:
    name: "Last Action: {display_name}"
    icon: mdi:gesture-tap-button
    initial: "None: Boot"

  # Previous scene before current
  {slug}_previous_scene:
    name: Previous {display_name} Scene
    icon: mdi:palette
    initial: "Reboot"

input_number:
  # Lux level below which brings on the auto lights
  {slug}_lights_on_threshold:
    name: {display_name} Threshold On
    min: 1
    max: 70

light:
  # TODO: fill in the actual light entities for this room
  - platform: group
    name: {display_name} Lights Master
    entities:
{light_entities}

input_boolean:
  # Boolean which is on during scene change
  {slug}_scene_changing:
    name: {display_name} Scene Change In Progress
    icon: mdi:repeat-once
    initial: false

  # Boolean which is on when lights are in auto mode
  {slug}_auto_mode_active:
    name: {display_name} Auto Mode
    icon: mdi:refresh-auto

  # Auto mode active
  {slug}_automatic_lights:
    name: {display_name} Automatic Lights Mode
    icon: mdi:refresh-auto

timer:
  # Timer set during each scene on script for transitions
  {slug}_scene_changing:
    name: Time For Scene Change
    icon: mdi:timer-sand-empty

  # Timer to prevent lights from waiting for light sensor to update
  {slug}_auto_off_override:
    name: Timer To Prevent Waiting For Lux Sensor
    icon: mdi:timer-sand-empty

automation:
  - alias: {display_name} Lights Auto On
    use_blueprint:
      path: lights/motion_auto_on.yaml
      input:
        motion_sensor: binary_sensor.{slug}_motion
        automatic_lights_boolean: input_boolean.{slug}_automatic_lights
        scenes_select: input_select.{slug}_scenes
        illuminance_sensor: sensor.hms_{slug}_illuminance
        threshold_number: input_number.{slug}_lights_on_threshold
        override_timer: timer.{slug}_auto_off_override
        last_action_text: input_text.{slug}_last_action
        auto_mode_boolean: input_boolean.{slug}_auto_mode_active
        daytime_script: script.{slug}_scene_{daytime_scene}
        nighttime_script: script.{slug}_scene_{nighttime_scene}

  - alias: {display_name} Lights Auto Off
    use_blueprint:
      path: lights/motion_auto_off.yaml
      input:
        motion_sensor: binary_sensor.{slug}_motion
        motion_timeout_number: input_number.{slug}_motion_timeout
        automatic_lights_boolean: input_boolean.{slug}_automatic_lights
        auto_mode_boolean: input_boolean.{slug}_auto_mode_active
        off_script: script.{slug}_scene_off
        last_action_text: input_text.{slug}_last_action
        override_timer: timer.{slug}_auto_off_override

  - alias: {display_name} Lights Manual Off Detection
    use_blueprint:
      path: lights/manual_off_detection.yaml
      input:
        lights_master: light.{slug}_lights_master
        scenes_select: input_select.{slug}_scenes
        off_script: script.{slug}_scene_off
        last_action_text: input_text.{slug}_last_action
        auto_mode_boolean: input_boolean.{slug}_auto_mode_active
{physical_automations}"""

PHYSICAL_TEMPLATE = """
  - alias: {display_name} Light Toggle
    use_blueprint:
      path: lights/physical_toggle.yaml
      input:
        trigger:
          - trigger: event
            event_type: shelly.click
            event_data:
              click_type: single
              device: {shelly_device}
              channel: {shelly_channel}
        changing_timer: timer.{slug}_scene_changing
        scenes_select: input_select.{slug}_scenes
        on_script: script.{slug}_scene_{daytime_scene}
        off_script: script.{slug}_scene_off
        auto_mode_boolean: input_boolean.{slug}_auto_mode_active

  - alias: {display_name} Scene Scroll
    use_blueprint:
      path: lights/scene_scroll.yaml
      input:
        trigger:
          - trigger: event
            event_type: shelly.click
            event_data:
              click_type: long
              device: {shelly_device}
              channel: {shelly_channel}
        changing_timer: timer.{slug}_scene_changing
        scroll_script: script.{slug}_scene_scroll
        auto_mode_boolean: input_boolean.{slug}_auto_mode_active
"""

PHYSICAL_TODO = """
  # TODO: no --shelly-device/--shelly-channel given, so the physical
  # toggle + scene scroll automations were skipped. Add them by hand
  # (copy from a similar room file) if this room has a physical switch.
"""


def slugify_default_name(slug: str) -> str:
    return slug.replace("_", " ").title()


def main():
    p = argparse.ArgumentParser(
        description="Scaffold a new packages/lights/<room>.yaml file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--slug", required=True, help="snake_case room id, e.g. garden_room")
    p.add_argument("--name", help="Display name, e.g. 'Garden Room' (default: derived from --slug)")
    p.add_argument(
        "--scenes",
        default="Bright,Relax,Cosy,Off",
        help="Comma-separated scene list (default: Bright,Relax,Cosy,Off). "
        "Each must have a matching script.<slug>_scene_<name lowercased> you create separately.",
    )
    p.add_argument("--daytime-scene", default="bright", help="Scene used for daytime auto-on (default: bright)")
    p.add_argument("--nighttime-scene", default="cosy", help="Scene used for nighttime auto-on (default: cosy)")
    p.add_argument(
        "--lights",
        default="",
        help="Comma-separated light entities for the room's master group (default: TODO placeholder)",
    )
    p.add_argument("--shelly-device", default=None, help="Shelly device id for physical toggle/scroll (optional)")
    p.add_argument("--shelly-channel", default="1", help="Shelly channel for physical toggle/scroll (default: 1)")
    p.add_argument("--write", action="store_true", help="Write to packages/lights/<slug>.yaml instead of stdout")
    p.add_argument(
        "--packages-dir",
        default="/homeassistant/packages/lights",
        help="Target directory for --write (default: /homeassistant/packages/lights)",
    )
    args = p.parse_args()

    slug = args.slug
    display_name = args.name or slugify_default_name(slug)
    scenes = [s.strip() for s in args.scenes.split(",") if s.strip()]
    scene_options = "\n".join(f'      - "{s}"' for s in scenes)

    if args.lights:
        lights = [e.strip() for e in args.lights.split(",") if e.strip()]
        light_entities = "\n".join(f"      - {e}" for e in lights)
    else:
        light_entities = f"      # TODO: add this room's light entities\n      - light.{slug}_TODO"

    if args.shelly_device:
        physical_automations = PHYSICAL_TEMPLATE.format(
            display_name=display_name,
            slug=slug,
            shelly_device=args.shelly_device,
            shelly_channel=args.shelly_channel,
            daytime_scene=args.daytime_scene,
        )
    else:
        physical_automations = PHYSICAL_TODO

    out = TEMPLATE.format(
        slug=slug,
        display_name=display_name,
        scene_options=scene_options,
        light_entities=light_entities,
        daytime_scene=args.daytime_scene,
        nighttime_scene=args.nighttime_scene,
        physical_automations=physical_automations,
    )

    if args.write:
        target = os.path.join(args.packages_dir, f"{slug}.yaml")
        if os.path.exists(target):
            print(f"Refusing to overwrite existing file: {target}", file=sys.stderr)
            sys.exit(1)
        with open(target, "w") as fh:
            fh.write(out)
        print(f"Wrote {target}")
        print()
        print("Still to do:")
        print(f"  1. Fill in the light: group entities (search for TODO in the file)")
        print(f"  2. Create script.{slug}_scene_<name> for each scene: {', '.join(scenes)}")
        print(f"  3. Add binary_sensor.{slug}_motion to packages/motion.yaml's template binary_sensor list")
        print(f"  4. Add input_number.{slug}_motion_timeout to packages/motion.yaml")
        if not args.shelly_device:
            print(f"  5. If this room has a physical switch, add the toggle/scroll automations by hand")
    else:
        print(out)


if __name__ == "__main__":
    main()
