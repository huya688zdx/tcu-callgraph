#include "adc.h"
#include "config.h"

unsigned int Adc_Read(unsigned char ch, unsigned int timeout)
{
    (void)timeout;
    return (unsigned int)ch * 10u;
}

unsigned int Adc_GetFiltered(unsigned char ch)
{
    unsigned int a = Adc_Read(ch, ADC_TIMEOUT_MS);
    unsigned int b = Adc_Read(ch, ADC_TIMEOUT_MS);

    return (a + b) / 2u;
}

void Adc_Init(void)
{
    unsigned int v = Adc_Read(0u, 1u);

    (void)v;
}
