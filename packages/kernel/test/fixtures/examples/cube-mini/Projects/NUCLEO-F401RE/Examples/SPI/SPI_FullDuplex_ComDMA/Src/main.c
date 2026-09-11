#include "stm32f4xx_hal.h"
int main(void) {
  HAL_SPI_TransmitReceive_DMA(0, 0, 0, 0);
  while (1) {}
}
