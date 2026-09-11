#include "stm32f4xx_hal.h"
int main(void) {
  HAL_GPIO_TogglePin(0, 0);
  while (1) {}
}
