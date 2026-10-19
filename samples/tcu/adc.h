#ifndef ADC_H
#define ADC_H

unsigned int Adc_Read(unsigned char ch, unsigned int timeout);
void Adc_Init(void);
unsigned int Adc_GetFiltered(unsigned char ch);

#endif
