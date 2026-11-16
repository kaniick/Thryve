//! `hald --pump-pin`: the GPIO that scripts/install-hal's `pump-off` drives low
//! after every hald stop (hald.service's `ExecStopPost=`), read from the same
//! actuator list hald drives, so hal.toml is the only place the pin is set.

use crate::config::Config;

/// The pump's pin when low is off for it (`pwm_pump`), else none. Never a pin a
/// light is on: the light stays as it is across a restart.
pub fn pump_off_pin(cfg: &Config) -> Option<u8> {
    let actuators = cfg.actuators();
    let pin = actuators
        .iter()
        .find(|a| a.id == "pump" && a.kind == "pwm_pump")?
        .pin?;
    let lit = actuators
        .iter()
        .any(|a| a.kind == "pwm_light" && a.pin == Some(pin));
    (!lit).then_some(pin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(toml: &str) -> Config {
        toml::from_str(toml).unwrap()
    }

    #[test]
    fn the_default_pump_pin() {
        assert_eq!(
            pump_off_pin(&Config::default()),
            Some(Config::default().pins.pump_pwm)
        );
        assert_eq!(pump_off_pin(&parse(crate::config::DEFAULT_CONFIG_TOML)), Some(24));
    }

    #[test]
    fn the_pin_hal_toml_gives_the_pump() {
        assert_eq!(pump_off_pin(&parse("[pins]\npump_pwm = 23\n")), Some(23));
        let listed = "[[actuator]]\nid = \"light\"\nkind = \"pwm_light\"\npin = 18\n\n\
                      [[actuator]]\nid = \"pump\"\nkind = \"pwm_pump\"\npin = 12\n";
        assert_eq!(pump_off_pin(&parse(listed)), Some(12));
    }

    #[test]
    fn never_the_light_pin() {
        assert_eq!(pump_off_pin(&parse("[pins]\npump_pwm = 18\n")), None);
    }

    #[test]
    fn nothing_for_a_pump_low_does_not_turn_off() {
        let dosing = "[[actuator]]\nid = \"pump\"\nkind = \"dosing\"\npin = 5\nactive_low = true\n";
        assert_eq!(pump_off_pin(&parse(dosing)), None);
        let no_pin = "[[actuator]]\nid = \"pump\"\nkind = \"pwm_pump\"\n";
        assert_eq!(pump_off_pin(&parse(no_pin)), None);
        let no_pump = "[[actuator]]\nid = \"light\"\nkind = \"pwm_light\"\npin = 18\n";
        assert_eq!(pump_off_pin(&parse(no_pump)), None);
    }
}
