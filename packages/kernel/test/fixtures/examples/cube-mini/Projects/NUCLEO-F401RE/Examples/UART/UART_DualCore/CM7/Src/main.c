#include "stm32f4xx_hal.h"
int main(void) {
  HAL_UART_Init(0);
  while (1) {}
}
