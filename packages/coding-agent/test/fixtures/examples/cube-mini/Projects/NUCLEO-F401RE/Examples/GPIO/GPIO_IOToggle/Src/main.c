#include "stm32f4xx_hal_gpio.h"
#include "stm32f4xx_hal_conf.h"
int main(void) {
  HAL_RCC_OscConfig(0);
  HAL_GPIO_TogglePin(0, 0);
  return 0;
}
